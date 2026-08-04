from datetime import datetime, timezone
import os

import requests
from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required, verify_jwt_in_request

from app.audit import log_audit
from app.auth.guards import roles_required
from app.extensions import db
from app.models import BehavioralLog, Exam, ExamSession, ExamStudentAssignment, Question, SessionAnswer, User
from app.models import FacialImage

sessions_bp = Blueprint("sessions", __name__)
VALID_EVENTS = {"gaze_away", "head_turned", "face_absent", "tab_switch", "multiple_faces", "identity_mismatch"}
_AI_SERVICE_URL = os.getenv("AI_SERVICE_URL", "http://localhost:8000")


def _can_view_session(role: str, user_id: int, exam: Exam) -> bool:
    if role == "admin":
        return True
    return role == "lecturer" and exam.lecturer_id == user_id


def _notify_ai_service(session_id: int, event: str, payload: dict) -> None:
    """Best-effort push of a socket event through the AI service's Socket.IO
    server, which is the only process holding the student's live websocket
    connection. Never let a slow/unreachable AI service block or fail the
    HTTP request that triggered this - see sockets/frame_handler equivalent
    calls in the other direction for the same fire-and-forget pattern."""
    expected_token = os.getenv("AI_SERVICE_TOKEN", "").strip()
    try:
        requests.post(
            f"{_AI_SERVICE_URL}/internal/broadcast",
            headers={"X-Internal-Token": expected_token} if expected_token else None,
            json={"session_id": session_id, "event": event, "payload": payload},
            timeout=3,
        )
    except requests.exceptions.RequestException:
        pass


def _student_can_access_exam(exam: Exam, student: User) -> bool:
    if not exam.programs:
        return True
    student_department = (student.department or "").strip()
    if any(program.name == student_department for program in exam.programs):
        return True
    return (
        ExamStudentAssignment.query.filter_by(exam_id=exam.exam_id, student_id=student.user_id).first()
        is not None
    )


def _student_profile_ready_for_verification(user: User) -> tuple[bool, str]:
    if not user:
        return False, "User not found"
    if not (user.full_name or "").strip():
        return False, "Complete your profile: full name is required."
    if not (user.reg_number or "").strip():
        return False, "Complete your profile: registration number is required."
    if not (user.email or "").strip():
        return False, "Complete your profile: email is required."
    if not (user.phone_number or "").strip():
        return False, "Complete your profile: phone number is required."
    if not (user.department or "").strip():
        return False, "Complete your profile: course/department is required."
    has_image = (
        FacialImage.query.filter_by(user_id=user.user_id)
        .order_by(FacialImage.captured_at.desc())
        .first()
        is not None
    )
    if not has_image:
        return False, "Upload your profile face image before starting an exam."
    if not bool(user.student_profile_confirmed):
        return False, "Confirm your student profile details from dashboard onboarding before starting an exam."
    return True, ""


@sessions_bp.post("/start")
@jwt_required()
def start_session():
    data = request.get_json(silent=True) or {}
    exam_id = data.get("exam_id")
    if not exam_id:
        return jsonify({"error": {"message": "exam_id is required"}}), 400

    exam = db.session.get(Exam, int(exam_id))
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if (exam.status or "").lower() not in {"scheduled", "live", "active"}:
        return jsonify({"error": {"message": "Exam is not open for session start"}}), 409
    if (exam.status or "").lower() == "scheduled" and exam.scheduled_at:
        now_utc = datetime.now(timezone.utc)
        scheduled_at = exam.scheduled_at
        if scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        if now_utc < scheduled_at:
            return jsonify({"error": {"message": "Exam has not started yet"}}), 409

    student_id = int(get_jwt_identity())
    student = db.session.get(User, student_id)
    ready, message = _student_profile_ready_for_verification(student)
    if not ready:
        return jsonify({"error": {"message": message}}), 409
    if not _student_can_access_exam(exam, student):
        return jsonify({"error": {"message": "You are not assigned to this exam."}}), 403
    existing = ExamSession.query.filter_by(student_id=student_id, exam_id=exam.exam_id).first()
    if existing:
        if existing.session_status in {"active", "pending"} and not existing.submitted_at:
            existing.submitted_at = datetime.utcnow()
            existing.session_status = "completed"
            db.session.commit()
            return (
                jsonify(
                    {
                        "error": {
                            "message": "Existing in-progress session was auto-submitted and cannot be resumed."
                        },
                        "session_id": existing.session_id,
                        "auto_submitted": True,
                    }
                ),
                409,
            )
        return jsonify({"error": {"message": "Exam session already exists and cannot be resumed."}, "session_id": existing.session_id}), 409

    session = ExamSession(
        student_id=student_id,
        exam_id=exam.exam_id,
        started_at=datetime.utcnow(),
        session_status="active",
        identity_verified=False,
        warning_count=0,
    )
    db.session.add(session)
    db.session.commit()

    return (
        jsonify(
            {
                "session_id": session.session_id,
                "exam": {
                    "exam_id": exam.exam_id,
                    "title": exam.title,
                    "duration_min": exam.duration_min,
                    "questions": [],
                },
            }
        ),
        201,
    )


@sessions_bp.post("/verify")
def verify_session_identity():
    expected_token = os.getenv("AI_SERVICE_TOKEN", "").strip()
    provided_token = (request.headers.get("X-Internal-Token") or "").strip()
    if not expected_token or provided_token != expected_token:
        return jsonify({"error": {"message": "Unauthorized internal request"}}), 401

    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    match_value = data.get("match")
    confidence_value = data.get("confidence_score")
    method = str(data.get("verification_method") or "ai-face-embedding")[:50]
    model_version = data.get("model_version")

    if session_id is None or match_value is None or confidence_value is None:
        return jsonify({"error": {"message": "session_id, match, and confidence_score are required"}}), 400
    if not isinstance(match_value, bool):
        return jsonify({"error": {"message": "match must be a boolean"}}), 400

    try:
        confidence_score = float(confidence_value)
    except (TypeError, ValueError):
        return jsonify({"error": {"message": "confidence_score must be numeric"}}), 400
    if confidence_score < 0 or confidence_score > 1:
        return jsonify({"error": {"message": "confidence_score must be between 0 and 1"}}), 400

    session = db.session.get(ExamSession, int(session_id))
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404

    threshold = 0.6
    is_verified = bool(match_value) and confidence_score >= threshold

    session.identity_verified = is_verified
    session.verification_score = confidence_score
    session.verification_method = method
    session.verification_details = {
        "match": bool(match_value),
        "threshold": threshold,
        "model_version": model_version,
    }
    if is_verified:
        session.verified_at = datetime.utcnow()

    db.session.add(
        BehavioralLog(
            session_id=session.session_id,
            event_type="identity_verification",
            event_data={
                "verified": is_verified,
                "match": bool(match_value),
                "confidence_score": round(confidence_score, 4),
                "threshold": threshold,
                "method": method,
                "model_version": model_version,
            },
        )
    )
    log_audit(
        action="session.identity_verification",
        actor_user_id=None,
        target_user_id=session.student_id,
        metadata={
            "session_id": session.session_id,
            "verified": is_verified,
            "confidence_score": round(confidence_score, 4),
            "threshold": threshold,
            "method": method,
            "model_version": model_version,
        },
    )
    db.session.commit()
    if not is_verified:
        return jsonify({"identity_verified": False, "message": "Face verification failed threshold check"}), 422
    return jsonify({"identity_verified": True, "confidence_score": round(confidence_score, 4), "verified_at": session.verified_at.isoformat() if session.verified_at else None}), 200


@sessions_bp.get("/internal/<int:session_id>")
def get_session_internal(session_id):
    """
    Trusted, internal-only lookup of a session's owning student. The AI
    service needs this to run its periodic mid-exam identity re-check
    against the CORRECT registered baseline - it must never trust a
    client-supplied user_id for this, since a socket payload is easy to
    spoof from the browser and would let an impostor simply claim their
    own account's user_id, which would then match their own face and
    defeat the whole check.
    """
    expected_token = os.getenv("AI_SERVICE_TOKEN", "").strip()
    provided_token = (request.headers.get("X-Internal-Token") or "").strip()
    if not expected_token or provided_token != expected_token:
        return jsonify({"error": {"message": "Unauthorized internal request"}}), 401

    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404

    return jsonify({
        "session_id": session.session_id,
        "student_id": session.student_id,
        "session_status": session.session_status,
    }), 200


@sessions_bp.get("/<int:session_id>/status")
@jwt_required()
def get_session_status(session_id):
    """
    Authoritative, server-side identity_verified check. The frontend's
    /exam page previously only checked a client-side localStorage flag set
    once on a successful verify and never re-validated - a stale flag from
    ANY prior successful verification (even by a different person, at any
    earlier point) would permanently bypass re-verification for that
    session_id. This endpoint reflects the actual, current DB state, which
    the /verify endpoint above already correctly overwrites (to False too)
    on every attempt.
    """
    user_id = int(get_jwt_identity())
    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404
    if session.student_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    return jsonify({
        "session_id": session.session_id,
        "identity_verified": bool(session.identity_verified),
        "session_status": session.session_status,
    }), 200


@sessions_bp.post("/log")
def log_event():
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    event_type = data.get("event_type")
    event_data = data.get("event_data") or {}

    if not session_id or event_type not in VALID_EVENTS:
        return jsonify({"error": {"message": "Invalid session_id or event_type"}}), 400

    session = db.session.get(ExamSession, int(session_id))
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404

    expected_internal_token = os.getenv("AI_SERVICE_TOKEN", "").strip()
    provided_internal_token = (request.headers.get("X-Internal-Token") or "").strip()
    internal_request = bool(expected_internal_token and provided_internal_token == expected_internal_token)

    if not internal_request:
        try:
            verify_jwt_in_request()
        except Exception:
            return jsonify({"error": {"message": "Missing or invalid authorization"}}), 401
        if session.student_id != int(get_jwt_identity()):
            return jsonify({"error": {"message": "Forbidden"}}), 403

    log_entry = BehavioralLog(
        session_id=session.session_id,
        event_type=event_type,
        event_data=event_data if isinstance(event_data, dict) else {},
    )
    db.session.add(log_entry)
    session.warning_count = (session.warning_count or 0) + 1

    # Anomalies (including identity mismatches) are recorded for
    # lecturer/admin post-exam review only - the exam is never auto-submitted
    # or locked mid-session because of them; the student always completes it.
    # A confirmed mid-exam identity mismatch still flips identity_verified
    # back to False so the /status guard blocks a *reload* back into the
    # exam under the wrong identity, without interrupting the current
    # in-progress session.
    if event_type == "identity_mismatch":
        session.identity_verified = False

    db.session.commit()

    # Push a live alert to any lecturer currently viewing this exam's
    # sessions & reports tab, so suspicious activity surfaces immediately
    # instead of only on the next manual refresh/report open.
    _notify_ai_service(
        session.session_id,
        "lecturer_alert",
        {
            "session_id": session.session_id,
            "log_id": log_entry.log_id,
            "event_type": event_type,
            "event_data": log_entry.event_data,
            "warning_count": session.warning_count,
            "logged_at": log_entry.logged_at.isoformat() if log_entry.logged_at else None,
        },
    )

    return jsonify({"warning_count": session.warning_count, "log_id": log_entry.log_id}), 200


@sessions_bp.get("/<int:session_id>/authorize-viewer")
@jwt_required()
def authorize_session_viewer(session_id):
    """
    Lets the AI service check, on behalf of a lecturer's browser socket,
    whether that lecturer/admin is allowed to subscribe to a given session's
    live alert stream - without the socket layer itself having to hold any
    DB access or duplicate the lecturer-owns-exam authorization rule already
    enforced on GET /api/reports/<session_id>.
    """
    claims = get_jwt()
    role = claims.get("role")
    user_id = int(get_jwt_identity())
    if role not in {"admin", "lecturer"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404
    exam = db.session.get(Exam, session.exam_id)
    if not exam or not _can_view_session(role, user_id, exam):
        return jsonify({"error": {"message": "Forbidden"}}), 403

    return jsonify({"session_id": session.session_id}), 200


@sessions_bp.post("/<int:session_id>/terminate")
@roles_required("lecturer", "admin")
def terminate_session(session_id):
    claims = get_jwt()
    role = claims.get("role")
    user_id = int(get_jwt_identity())

    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404
    exam = db.session.get(Exam, session.exam_id)
    if not exam or not _can_view_session(role, user_id, exam):
        return jsonify({"error": {"message": "Forbidden"}}), 403

    if session.session_status in {"completed", "terminated"}:
        return jsonify({"error": {"message": "Session has already ended"}}), 409

    data = request.get_json(silent=True) or {}
    reason = str(data.get("reason") or "Suspicious activity detected during your exam.")[:255]

    # A terminated session still gets credit for whatever the student had
    # already answered correctly, rather than a blanket zero. Answers are
    # autosaved to SessionAnswer via POST /<id>/answer as the student picks
    # them (see save_answer below) specifically so this is possible - before
    # that endpoint existed, in-progress answers only lived in the student's
    # browser and a lecturer terminating a session had nothing to score.
    answered = SessionAnswer.query.filter_by(session_id=session.session_id).all()
    questions_by_id = {q.question_id: q for q in Question.query.filter_by(exam_id=session.exam_id).all()}
    score = sum(
        float(questions_by_id[a.question_id].marks or 1)
        for a in answered
        if a.is_correct and a.question_id in questions_by_id
    )
    session.score = score

    session.session_status = "terminated"
    session.termination_reason = reason
    session.terminated_by = user_id
    if not session.submitted_at:
        session.submitted_at = datetime.utcnow()

    db.session.add(
        BehavioralLog(
            session_id=session.session_id,
            event_type="session_terminated",
            event_data={"reason": reason, "terminated_by": user_id},
        )
    )
    log_audit(
        action="session.terminated",
        actor_user_id=user_id,
        target_user_id=session.student_id,
        metadata={"session_id": session.session_id, "reason": reason, "score": score},
    )
    db.session.commit()

    _notify_ai_service(
        session.session_id,
        "session_terminated",
        {"session_id": session.session_id, "reason": reason, "score": score},
    )

    return jsonify(
        {"session_id": session.session_id, "session_status": session.session_status, "score": float(session.score)}
    ), 200


@sessions_bp.post("/<int:session_id>/warn")
@roles_required("lecturer", "admin")
def warn_session(session_id):
    """
    Lets a lecturer/admin who's watching a session's warning_count climb
    send the student a direct, real-time warning - a step short of
    terminate_session above. Unlike the automated anomaly path in
    log_event(), this is a deliberate human decision, so it's a distinct
    endpoint gated by role rather than the internal AI-service token, and
    it increments warning_count the same way an automated anomaly would so
    it's reflected in risk_level/reports alongside AI-detected warnings.
    """
    claims = get_jwt()
    role = claims.get("role")
    user_id = int(get_jwt_identity())

    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404
    exam = db.session.get(Exam, session.exam_id)
    if not exam or not _can_view_session(role, user_id, exam):
        return jsonify({"error": {"message": "Forbidden"}}), 403

    if session.session_status not in {"active", "pending"}:
        return jsonify({"error": {"message": "Session is not active"}}), 409

    data = request.get_json(silent=True) or {}
    message = str(
        data.get("message")
        or "Your invigilator has flagged unusual activity. Please stay focused on your exam."
    )[:255]

    session.warning_count = (session.warning_count or 0) + 1

    log_entry = BehavioralLog(
        session_id=session.session_id,
        event_type="lecturer_warning",
        event_data={"message": message, "sent_by": user_id},
    )
    db.session.add(log_entry)
    log_audit(
        action="session.lecturer_warning",
        actor_user_id=user_id,
        target_user_id=session.student_id,
        metadata={"session_id": session.session_id, "message": message, "warning_count": session.warning_count},
    )
    db.session.commit()

    _notify_ai_service(
        session.session_id,
        "manual_warning",
        {
            "session_id": session.session_id,
            "message": message,
            "warning_count": session.warning_count,
            "logged_at": log_entry.logged_at.isoformat() if log_entry.logged_at else None,
        },
    )

    return jsonify({"session_id": session.session_id, "warning_count": session.warning_count, "log_id": log_entry.log_id}), 200


@sessions_bp.post("/<int:session_id>/answer")
@jwt_required()
def save_answer(session_id):
    """
    Autosaves a single answer as the student picks it, independent of the
    full-payload POST /<id>/submit at the end of the exam. Without this, a
    student's in-progress answers only ever existed in the browser's React
    state - a lecturer terminating a session mid-exam (see terminate_session
    above) would have no answers in the database to score. Upserts on the
    (session_id, question_id) unique constraint so re-picking an answer for
    a question just updates that row instead of creating duplicates.
    """
    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404
    if session.student_id != int(get_jwt_identity()):
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if session.session_status not in {"active", "pending"}:
        return jsonify({"error": {"message": "Session is not active"}}), 409

    data = request.get_json(silent=True) or {}
    question_id = data.get("question_id")
    selected_answer = data.get("selected_answer")
    if question_id is None or not selected_answer:
        return jsonify({"error": {"message": "question_id and selected_answer are required"}}), 400

    question = db.session.get(Question, int(question_id))
    if not question or question.exam_id != session.exam_id:
        return jsonify({"error": {"message": "Question does not belong to this session's exam"}}), 400

    is_correct = str(question.correct_answer).upper() == str(selected_answer).upper()
    existing = SessionAnswer.query.filter_by(session_id=session.session_id, question_id=question.question_id).first()
    if existing:
        existing.selected_answer = str(selected_answer)
        existing.is_correct = is_correct
        existing.answered_at = datetime.utcnow()
    else:
        db.session.add(
            SessionAnswer(
                session_id=session.session_id,
                question_id=question.question_id,
                selected_answer=str(selected_answer),
                is_correct=is_correct,
            )
        )
    db.session.commit()

    return jsonify({"question_id": question.question_id, "is_correct": is_correct}), 200


@sessions_bp.post("/<int:session_id>/submit")
@jwt_required()
def submit_session(session_id):
    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404
    if session.student_id != int(get_jwt_identity()):
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if session.session_status == "terminated":
        return jsonify({"error": {"message": "This session was terminated and can no longer be submitted."}}), 409

    data = request.get_json(silent=True) or {}
    raw_answers = data.get("answers") or {}

    # Frontend currently sends a question-number -> option-index map;
    # contract also allows list payloads, so support both formats.
    answer_map = {}
    if isinstance(raw_answers, list):
        for entry in raw_answers:
            qid = entry.get("question_id")
            selected = entry.get("selected_answer")
            if qid is not None and selected is not None:
                answer_map[str(qid)] = str(selected)
    elif isinstance(raw_answers, dict):
        answer_map = {str(k): str(v) for k, v in raw_answers.items()}

    exam_questions = Question.query.filter_by(exam_id=session.exam_id).all()
    by_qid = {str(question.question_id): question for question in exam_questions}

    SessionAnswer.query.filter_by(session_id=session.session_id).delete()

    score = 0.0
    for key, selected in answer_map.items():
        question = by_qid.get(key)
        if not question:
            continue
        is_correct = str(question.correct_answer).upper() == str(selected).upper()
        db.session.add(
            SessionAnswer(
                session_id=session.session_id,
                question_id=question.question_id,
                selected_answer=str(selected),
                is_correct=is_correct,
            )
        )
        if is_correct:
            score += float(question.marks or 1)

    session.score = score
    session.session_status = "completed" if session.session_status != "locked" else "locked"
    session.submitted_at = datetime.utcnow()
    db.session.commit()

    return jsonify({"score": float(score), "session_id": session.session_id}), 200


@sessions_bp.get("/<int:session_id>/answers")
@jwt_required()
def get_session_answers(session_id):
    session = db.session.get(ExamSession, session_id)
    if not session:
        return jsonify({"error": {"message": "Session not found"}}), 404
    if session.student_id != int(get_jwt_identity()):
        return jsonify({"error": {"message": "Forbidden"}}), 403

    stored = SessionAnswer.query.filter_by(session_id=session.session_id).all()
    return (
        jsonify(
            {
                "session_id": session.session_id,
                "answers": [
                    {
                        "question_id": row.question_id,
                        "selected_answer": row.selected_answer,
                        "is_correct": row.is_correct,
                        "answered_at": row.answered_at.isoformat() if row.answered_at else None,
                    }
                    for row in stored
                ],
            }
        ),
        200,
    )


@sessions_bp.get("")
@jwt_required()
def list_sessions():
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())

    sessions = (
        db.session.query(ExamSession, Exam, User)
        .join(Exam, Exam.exam_id == ExamSession.exam_id)
        .join(User, User.user_id == ExamSession.student_id)
        .order_by(ExamSession.session_id.desc())
    )
    if role == "lecturer":
        sessions = sessions.filter(Exam.lecturer_id == user_id)
    elif role == "student":
        sessions = sessions.filter(ExamSession.student_id == user_id)
    elif role != "admin":
        return jsonify({"error": {"message": "Forbidden"}}), 403
    sessions = sessions.all()

    exam_ids = {exam.exam_id for _, exam, _ in sessions}
    total_marks_by_exam = {}
    if exam_ids:
        for exam_id, total in (
            db.session.query(Question.exam_id, db.func.coalesce(db.func.sum(Question.marks), 0))
            .filter(Question.exam_id.in_(exam_ids))
            .group_by(Question.exam_id)
            .all()
        ):
            total_marks_by_exam[exam_id] = int(total)

    payload = []
    for session, exam, student in sessions:
        if session.warning_count >= 3:
            risk_level = "high"
        elif session.warning_count > 1:
            risk_level = "medium"
        else:
            risk_level = "low"
        payload.append(
            {
                "session_id": session.session_id,
                "student_name": student.full_name,
                "student_id": session.student_id,
                "registration_number": student.reg_number,
                "student_email": student.email,
                "exam_title": exam.title,
                "exam_id": exam.exam_id,
                "course_code": exam.course_code,
                "scheduled_at": exam.scheduled_at.isoformat() if exam.scheduled_at else None,
                "session_status": session.session_status,
                "score": float(session.score) if session.score is not None else None,
                "total_marks": total_marks_by_exam.get(exam.exam_id, 0),
                "warning_count": session.warning_count,
                "risk_level": risk_level,
            }
        )

    return jsonify({"sessions": payload}), 200
