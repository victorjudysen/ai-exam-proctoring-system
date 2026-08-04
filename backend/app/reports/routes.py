import csv
import io
from datetime import datetime

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from app.audit import log_audit
from app.extensions import db
from app.models import BehavioralLog, Exam, ExamSession, Question, Report, User

reports_bp = Blueprint("reports", __name__)


def _can_view_session(user_role, user_id, session_row, exam_row):
    if user_role == "admin":
        return True
    if user_role == "lecturer" and exam_row.lecturer_id == user_id:
        return True
    return False


def _total_marks_by_exam_id(exam_ids):
    """Sum of Question.marks per exam_id, for rendering score as "X/Y"
    instead of a bare number. Batched across all requested exam_ids rather
    than queried per-row to avoid N+1 queries in the list endpoints."""
    if not exam_ids:
        return {}
    rows = (
        db.session.query(Question.exam_id, db.func.coalesce(db.func.sum(Question.marks), 0))
        .filter(Question.exam_id.in_(set(exam_ids)))
        .group_by(Question.exam_id)
        .all()
    )
    return {exam_id: int(total) for exam_id, total in rows}


def _build_report_snapshot(session_row):
    logs = BehavioralLog.query.filter_by(session_id=session_row.session_id).all()
    counts = {
        "gaze_away": 0,
        "head_turned": 0,
        "tab_switch": 0,
        "face_absent": 0,
        "multiple_faces": 0,
        # Previously omitted here despite incrementing warning_count in
        # log_event() - meant total_anomalies could silently undercount
        # relative to warning_count with no visible reason why. Counted here
        # too now so the two numbers only ever diverge for the one reason
        # that's actually meaningful: a lecturer's own manual warning.
        "identity_mismatch": 0,
    }
    for log in logs:
        if log.event_type in counts:
            counts[log.event_type] += 1

    total_anomalies = sum(counts.values())
    if total_anomalies > 10 or (session_row.warning_count or 0) >= 3:
        risk_level = "high"
    elif total_anomalies > 5:
        risk_level = "medium"
    else:
        risk_level = "low"

    return counts, total_anomalies, risk_level, logs


@reports_bp.get("/<int:session_id>")
@jwt_required()
def get_report(session_id):
    claims = get_jwt()
    user_role = claims.get("role")
    user_id = int(get_jwt_identity())
    if user_role not in {"admin", "lecturer"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    joined = (
        db.session.query(ExamSession, Exam, User)
        .join(Exam, Exam.exam_id == ExamSession.exam_id)
        .join(User, User.user_id == ExamSession.student_id)
        .filter(ExamSession.session_id == session_id)
        .first()
    )
    if not joined:
        return jsonify({"error": {"message": "Session not found"}}), 404

    session_row, exam_row, student_row = joined
    if not _can_view_session(user_role, user_id, session_row, exam_row):
        return jsonify({"error": {"message": "Forbidden"}}), 403

    counts, total_anomalies, risk_level, logs = _build_report_snapshot(session_row)
    report = Report.query.filter_by(session_id=session_row.session_id).first()
    if not report:
        report = Report(session_id=session_row.session_id)
        db.session.add(report)
    # Always refresh from the live snapshot rather than only writing this
    # row once - a session's logs can keep growing after the first time
    # anyone opens its report, and a write-once cache would silently freeze
    # these counts at whatever they were on that first view (confirmed: this
    # produced a response where identity_mismatch_count, computed live below,
    # didn't agree with the stale cached total_anomalies it should sum into).
    report.gaze_away_count = counts["gaze_away"]
    report.head_turned_count = counts["head_turned"]
    report.tab_switch_count = counts["tab_switch"]
    report.face_absent_count = counts["face_absent"]
    report.multiple_faces_count = counts["multiple_faces"]
    report.total_anomalies = total_anomalies
    report.risk_level = risk_level
    db.session.commit()

    total_marks = _total_marks_by_exam_id([exam_row.exam_id]).get(exam_row.exam_id, 0)

    return (
        jsonify(
            {
                "report": {
                    "session_id": session_row.session_id,
                    "student": {
                        "user_id": student_row.user_id,
                        "full_name": student_row.full_name,
                        "reg_number": student_row.reg_number,
                        "email": student_row.email,
                    },
                    "exam": {
                        "exam_id": exam_row.exam_id,
                        "title": exam_row.title,
                        "course_code": exam_row.course_code,
                    },
                    "gaze_away_count": report.gaze_away_count,
                    "head_turned_count": report.head_turned_count,
                    "tab_switch_count": report.tab_switch_count,
                    "face_absent_count": report.face_absent_count,
                    "multiple_faces_count": report.multiple_faces_count,
                    "identity_mismatch_count": counts["identity_mismatch"],
                    "total_anomalies": report.total_anomalies,
                    "risk_level": report.risk_level,
                    "score": float(session_row.score) if session_row.score is not None else None,
                    "total_marks": total_marks,
                    "warning_count": session_row.warning_count or 0,
                    "session_status": session_row.session_status,
                    "logs": [
                        {
                            "log_id": log.log_id,
                            "event_type": log.event_type,
                            "event_data": log.event_data or {},
                            "logged_at": log.logged_at.isoformat() if log.logged_at else None,
                            "is_suspicious": log.is_suspicious,
                            "reviewed_by": log.reviewed_by,
                            "reviewed_at": log.reviewed_at.isoformat() if log.reviewed_at else None,
                        }
                        for log in logs
                    ],
                }
            }
        ),
        200,
    )


@reports_bp.patch("/logs/<int:log_id>/review")
@jwt_required()
def review_log(log_id):
    """
    Lets a lecturer (or admin) record their judgement call on a specific
    flagged behavioural event - was it actually suspicious, or a false
    positive (e.g. adjusting posture, brief glance away)? This is a per-event
    decision rather than a whole-session one, since a single session can mix
    genuinely suspicious events with harmless ones.
    """
    claims = get_jwt()
    user_role = claims.get("role")
    user_id = int(get_jwt_identity())
    if user_role not in {"admin", "lecturer"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    log = db.session.get(BehavioralLog, log_id)
    if not log:
        return jsonify({"error": {"message": "Log entry not found"}}), 404

    joined = (
        db.session.query(ExamSession, Exam)
        .join(Exam, Exam.exam_id == ExamSession.exam_id)
        .filter(ExamSession.session_id == log.session_id)
        .first()
    )
    if not joined:
        return jsonify({"error": {"message": "Session not found"}}), 404
    session_row, exam_row = joined
    if not _can_view_session(user_role, user_id, session_row, exam_row):
        return jsonify({"error": {"message": "Forbidden"}}), 403

    data = request.get_json(silent=True) or {}
    is_suspicious = data.get("is_suspicious")
    if not isinstance(is_suspicious, bool):
        return jsonify({"error": {"message": "is_suspicious (boolean) is required"}}), 400

    log.is_suspicious = is_suspicious
    log.reviewed_by = user_id
    log.reviewed_at = datetime.utcnow()
    log_audit(
        action="report.log_reviewed",
        actor_user_id=user_id,
        target_user_id=session_row.student_id,
        metadata={"session_id": session_row.session_id, "log_id": log.log_id, "is_suspicious": is_suspicious},
    )
    db.session.commit()

    return (
        jsonify(
            {
                "log_id": log.log_id,
                "is_suspicious": log.is_suspicious,
                "reviewed_by": log.reviewed_by,
                "reviewed_at": log.reviewed_at.isoformat(),
            }
        ),
        200,
    )


@reports_bp.get("/my")
@jwt_required()
def my_reports():
    user_role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if user_role != "student":
        return jsonify({"error": {"message": "Forbidden"}}), 403

    rows = (
        db.session.query(ExamSession, Exam)
        .join(Exam, Exam.exam_id == ExamSession.exam_id)
        .filter(ExamSession.student_id == user_id)
        .order_by(ExamSession.session_id.desc())
        .all()
    )

    total_marks_by_exam = _total_marks_by_exam_id([exam_row.exam_id for _, exam_row in rows])

    payload = []
    for session_row, exam_row in rows:
        counts, total_anomalies, risk_level, _ = _build_report_snapshot(session_row)
        payload.append(
            {
                "session_id": session_row.session_id,
                "exam_id": exam_row.exam_id,
                "exam_title": exam_row.title,
                "course_code": exam_row.course_code,
                "score": float(session_row.score) if session_row.score is not None else None,
                "total_marks": total_marks_by_exam.get(exam_row.exam_id, 0),
                "warning_count": session_row.warning_count or 0,
                "risk_level": risk_level,
                "total_anomalies": total_anomalies,
                "gaze_away_count": counts["gaze_away"],
                "head_turned_count": counts["head_turned"],
                "tab_switch_count": counts["tab_switch"],
                "face_absent_count": counts["face_absent"],
                "multiple_faces_count": counts["multiple_faces"],
                "identity_mismatch_count": counts["identity_mismatch"],
                "session_status": session_row.session_status,
            }
        )

    return jsonify({"reports": payload}), 200


@reports_bp.get("/export")
@jwt_required()
def export_all_reports():
    claims = get_jwt()
    user_role = claims.get("role")
    user_id = int(get_jwt_identity())
    if user_role not in {"admin", "lecturer"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    query = (
        db.session.query(ExamSession, Exam, User)
        .join(Exam, Exam.exam_id == ExamSession.exam_id)
        .join(User, User.user_id == ExamSession.student_id)
    )
    if user_role == "lecturer":
        query = query.filter(Exam.lecturer_id == user_id)
    rows = query.order_by(Exam.exam_id, ExamSession.session_id).all()
    total_marks_by_exam = _total_marks_by_exam_id([exam_row.exam_id for _, exam_row, _ in rows])

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "exam_id",
            "exam_title",
            "course_code",
            "session_id",
            "student_name",
            "reg_number",
            "score",
            "total_marks",
            "warning_count",
            "risk_level",
            "status",
        ]
    )

    for session_row, exam_row, user_row in rows:
        _, _, risk_level, _ = _build_report_snapshot(session_row)
        writer.writerow(
            [
                exam_row.exam_id,
                exam_row.title,
                exam_row.course_code,
                session_row.session_id,
                user_row.full_name,
                user_row.reg_number,
                float(session_row.score or 0),
                total_marks_by_exam.get(exam_row.exam_id, 0),
                session_row.warning_count,
                risk_level,
                session_row.session_status,
            ]
        )

    csv_data = output.getvalue()
    output.close()
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": 'attachment; filename="all_exam_reports.csv"'},
    )


@reports_bp.get("/export/<int:exam_id>")
@jwt_required()
def export_exam_reports(exam_id):
    claims = get_jwt()
    user_role = claims.get("role")
    user_id = int(get_jwt_identity())
    if user_role not in {"admin", "lecturer"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if user_role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    rows = (
        db.session.query(ExamSession, User)
        .join(User, User.user_id == ExamSession.student_id)
        .filter(ExamSession.exam_id == exam_id)
        .all()
    )
    total_marks = _total_marks_by_exam_id([exam_id]).get(exam_id, 0)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "session_id",
            "student_name",
            "reg_number",
            "score",
            "total_marks",
            "warning_count",
            "risk_level",
            "status",
        ]
    )

    for session_row, user_row in rows:
        _, total_anomalies, risk_level, _ = _build_report_snapshot(session_row)
        writer.writerow(
            [
                session_row.session_id,
                user_row.full_name,
                user_row.reg_number,
                float(session_row.score or 0),
                total_marks,
                session_row.warning_count,
                risk_level if total_anomalies > 0 else "low",
                session_row.session_status,
            ]
        )

    csv_data = output.getvalue()
    output.close()
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": f'attachment; filename="exam_report_{exam_id}.csv"'},
    )
