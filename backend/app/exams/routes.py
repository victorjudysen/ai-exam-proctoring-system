import csv
import io
from datetime import datetime

from flask import Blueprint, Response, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

from app.extensions import db
from app.models import (
    BehavioralLog,
    DegreeProgram,
    Exam,
    ExamSession,
    ExamStudentAssignment,
    Question,
    Report,
    SessionAnswer,
    User,
)

exams_bp = Blueprint("exams", __name__)

# Single source of truth for the bulk-upload CSV shape so the downloadable
# template and the parser can never drift apart into "different/corrupted
# columns" per lecturer.
QUESTION_CSV_COLUMNS = [
    "question_text",
    "question_type",
    "option_a",
    "option_b",
    "option_c",
    "option_d",
    "correct_answer",
    "marks",
]
QUESTION_CSV_REQUIRED_COLUMNS = {"question_text", "question_type", "correct_answer"}


def _lecturer_profile_confirmed(user_id: int) -> bool:
    user = db.session.get(User, user_id)
    return bool(user and user.role == "lecturer" and user.lecturer_profile_confirmed)


def _delete_exam_cascade(exam_id: int) -> None:
    session_ids = [
        row[0]
        for row in db.session.query(ExamSession.session_id).filter(ExamSession.exam_id == exam_id).all()
    ]
    if session_ids:
        Report.query.filter(Report.session_id.in_(session_ids)).delete(synchronize_session=False)
        SessionAnswer.query.filter(SessionAnswer.session_id.in_(session_ids)).delete(synchronize_session=False)
        BehavioralLog.query.filter(BehavioralLog.session_id.in_(session_ids)).delete(synchronize_session=False)
        ExamSession.query.filter(ExamSession.session_id.in_(session_ids)).delete(synchronize_session=False)
    Question.query.filter_by(exam_id=exam_id).delete(synchronize_session=False)
    Exam.query.filter_by(exam_id=exam_id).delete(synchronize_session=False)


@exams_bp.get("")
@jwt_required()
def list_exams():
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    status_filter = request.args.get("status")
    query = Exam.query
    if role == "lecturer":
        query = query.filter_by(lecturer_id=user_id)
    if role == "student":
        query = query.filter(Exam.status.in_(["scheduled", "live", "completed"]))
        student = db.session.get(User, user_id)
        student_department = (student.department or "").strip() if student else ""
        assigned_exam_ids = db.session.query(ExamStudentAssignment.exam_id).filter(
            ExamStudentAssignment.student_id == user_id
        )
        query = query.filter(
            db.or_(
                ~Exam.programs.any(),
                Exam.programs.any(DegreeProgram.name == student_department),
                Exam.exam_id.in_(assigned_exam_ids),
            )
        )
    if status_filter:
        query = query.filter_by(status=status_filter)

    exams = query.order_by(Exam.created_at.desc()).all()
    lecturer_ids = list({int(exam.lecturer_id) for exam in exams if exam.lecturer_id is not None})
    lecturer_rows = User.query.filter(User.user_id.in_(lecturer_ids)).all() if lecturer_ids else []
    lecturer_map = {row.user_id: row.full_name for row in lecturer_rows}
    return jsonify(
        {
            "exams": [
                {
                    "id": exam.exam_id,
                    "exam_id": exam.exam_id,
                    "title": exam.title,
                    "course_code": exam.course_code,
                    "duration_min": exam.duration_min,
                    "scheduled_at": exam.scheduled_at.isoformat() if exam.scheduled_at else None,
                    "status": exam.status,
                    "lecturer_id": exam.lecturer_id,
                    "lecturer_name": lecturer_map.get(exam.lecturer_id),
                    "programs": [
                        {"program_id": program.program_id, "name": program.name} for program in exam.programs
                    ],
                }
                for exam in exams
            ]
        }
    ), 200


@exams_bp.get("/programs")
@jwt_required()
def list_degree_programs():
    programs = DegreeProgram.query.order_by(DegreeProgram.name.asc()).all()
    return jsonify(
        {"programs": [{"program_id": program.program_id, "name": program.name} for program in programs]}
    ), 200


@exams_bp.get("/questions/template")
@jwt_required()
def download_question_csv_template():
    role = get_jwt().get("role")
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(QUESTION_CSV_COLUMNS)
    writer.writerow(["What is 2 + 2?", "mcq", "3", "4", "5", "6", "B", "1"])
    writer.writerow(["The Earth orbits the Sun.", "true_false", "", "", "", "", "TRUE", "1"])

    return Response(
        buffer.getvalue().encode("utf-8-sig"),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=question_upload_template.csv"},
    )


@exams_bp.post("")
@jwt_required()
def create_exam():
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    course_code = (data.get("course_code") or "").strip()
    duration_min = data.get("duration_min")
    scheduled_raw = data.get("scheduled_at")
    program_ids = data.get("program_ids") or []

    if not title or not course_code or not duration_min:
        return jsonify({"error": {"message": "Missing required fields"}}), 400
    if not isinstance(program_ids, list) or not program_ids:
        return jsonify({"error": {"message": "Select at least one degree program"}}), 400

    programs = DegreeProgram.query.filter(DegreeProgram.program_id.in_(program_ids)).all()
    if len(programs) != len(set(program_ids)):
        return jsonify({"error": {"message": "One or more selected degree programs are invalid"}}), 400

    scheduled_at = None
    if scheduled_raw:
        try:
            scheduled_at = datetime.fromisoformat(scheduled_raw.replace("Z", "+00:00"))
        except ValueError:
            return jsonify({"error": {"message": "Invalid scheduled_at format"}}), 400

    exam = Exam(
        title=title,
        course_code=course_code,
        lecturer_id=user_id,
        duration_min=int(duration_min),
        scheduled_at=scheduled_at,
        status="draft",
        programs=programs,
    )
    db.session.add(exam)
    db.session.commit()

    return jsonify({"exam_id": exam.exam_id, "id": exam.exam_id}), 201


@exams_bp.patch("/<int:exam_id>/status")
@jwt_required()
def update_exam_status(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    data = request.get_json(silent=True) or {}
    status = (data.get("status") or "").strip().lower()
    if status not in {"draft", "scheduled", "live", "completed"}:
        return jsonify({"error": {"message": "Invalid status"}}), 400
    if status in {"scheduled", "live"}:
        question_exists = Question.query.filter_by(exam_id=exam.exam_id).first() is not None
        if not question_exists:
            return jsonify({"error": {"message": "Add at least one question before scheduling or going live"}}), 409
    exam.status = status
    db.session.commit()
    return jsonify({"message": "Exam status updated", "status": exam.status}), 200


@exams_bp.put("/<int:exam_id>")
@jwt_required()
def update_exam(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    data = request.get_json(silent=True) or {}
    title = (data.get("title") or exam.title).strip()
    course_code = (data.get("course_code") or exam.course_code).strip()
    duration_min = int(data.get("duration_min") or exam.duration_min)
    scheduled_raw = data.get("scheduled_at")
    program_ids = data.get("program_ids")

    scheduled_at = exam.scheduled_at
    if scheduled_raw:
        try:
            scheduled_at = datetime.fromisoformat(str(scheduled_raw).replace("Z", "+00:00"))
        except ValueError:
            return jsonify({"error": {"message": "Invalid scheduled_at format"}}), 400

    if not title or not course_code or duration_min <= 0:
        return jsonify({"error": {"message": "title, course_code and positive duration_min are required"}}), 400

    if program_ids is not None:
        if not isinstance(program_ids, list) or not program_ids:
            return jsonify({"error": {"message": "Select at least one degree program"}}), 400
        programs = DegreeProgram.query.filter(DegreeProgram.program_id.in_(program_ids)).all()
        if len(programs) != len(set(program_ids)):
            return jsonify({"error": {"message": "One or more selected degree programs are invalid"}}), 400
        exam.programs = programs

    exam.title = title
    exam.course_code = course_code
    exam.duration_min = duration_min
    exam.scheduled_at = scheduled_at
    db.session.commit()

    return jsonify({"message": "Exam updated successfully"}), 200


@exams_bp.delete("/<int:exam_id>")
@jwt_required()
def delete_exam(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    force_delete = (request.args.get("force") or "").strip().lower() == "true"
    if force_delete and role != "admin":
        return jsonify({"error": {"message": "Only admin can force delete exams with session history"}}), 403

    # Prevent deletion once sessions exist to preserve integrity/audit history.
    if ExamSession.query.filter_by(exam_id=exam.exam_id).first() and not force_delete:
        return jsonify({"error": {"message": "Exam has active/history sessions and cannot be deleted"}}), 409

    _delete_exam_cascade(exam.exam_id)
    db.session.commit()
    return jsonify({"message": "Exam deleted", "force_deleted": force_delete}), 200


@exams_bp.get("/<int:exam_id>")
@jwt_required()
def get_exam(exam_id):
    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404

    claims = get_jwt()
    can_view_answers = claims.get("role") in {"lecturer", "admin"}
    questions = Question.query.filter_by(exam_id=exam.exam_id).order_by(Question.order_num.asc()).all()

    payload_questions = []
    for question in questions:
        question_payload = {
            "question_id": question.question_id,
            "question_text": question.question_text,
            "option_a": question.option_a,
            "option_b": question.option_b,
            "option_c": question.option_c,
            "option_d": question.option_d,
            "question_type": question.question_type,
            "marks": question.marks,
            "order_num": question.order_num,
        }
        if can_view_answers:
            question_payload["correct_answer"] = question.correct_answer
        payload_questions.append(question_payload)

    return (
        jsonify(
            {
                "exam": {
                    "exam_id": exam.exam_id,
                    "title": exam.title,
                    "course_code": exam.course_code,
                    "duration_min": exam.duration_min,
                    "scheduled_at": exam.scheduled_at.isoformat() if exam.scheduled_at else None,
                    "status": exam.status,
                    "programs": [
                        {"program_id": program.program_id, "name": program.name} for program in exam.programs
                    ],
                },
                "questions": payload_questions,
            }
        ),
        200,
    )


@exams_bp.post("/<int:exam_id>/questions")
@jwt_required()
def create_question(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    data = request.get_json(silent=True) or {}
    question_text = (data.get("question_text") or "").strip()
    question_type = (data.get("question_type") or "mcq").strip().lower()
    correct_answer = (data.get("correct_answer") or "").strip().upper()
    marks = int(data.get("marks") or 1)
    order_num = int(data.get("order_num") or 0)

    if not question_text or question_type not in {"mcq", "true_false"}:
        return jsonify({"error": {"message": "question_text and valid question_type are required"}}), 400
    if not correct_answer:
        return jsonify({"error": {"message": "correct_answer is required"}}), 400

    question = Question(
        exam_id=exam.exam_id,
        question_text=question_text,
        question_type=question_type,
        option_a=(data.get("option_a") or "").strip() or None,
        option_b=(data.get("option_b") or "").strip() or None,
        option_c=(data.get("option_c") or "").strip() or None,
        option_d=(data.get("option_d") or "").strip() or None,
        correct_answer=correct_answer,
        marks=marks,
        order_num=order_num,
    )
    db.session.add(question)
    db.session.commit()
    return jsonify({"question_id": question.question_id}), 201


@exams_bp.post("/<int:exam_id>/questions/bulk")
@jwt_required()
def bulk_upload_questions(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"error": {"message": "CSV file is required"}}), 400
    if not upload.filename.lower().endswith(".csv"):
        return jsonify({"error": {"message": "File must be a .csv — download and use the provided template"}}), 400

    try:
        raw_text = upload.read().decode("utf-8-sig")
    except UnicodeDecodeError:
        return jsonify({"error": {"message": "Could not read the file — save it as UTF-8 CSV and try again"}}), 400

    reader = csv.DictReader(io.StringIO(raw_text))
    header_columns = {(name or "").strip().lower() for name in (reader.fieldnames or [])}
    missing_columns = QUESTION_CSV_REQUIRED_COLUMNS - header_columns
    if missing_columns:
        return jsonify(
            {
                "error": {
                    "message": (
                        "CSV is missing required column(s): "
                        f"{', '.join(sorted(missing_columns))}. "
                        "Download the template from this page and fill it in without changing the columns."
                    )
                }
            }
        ), 400

    next_order = Question.query.filter_by(exam_id=exam.exam_id).count() + 1
    to_create = []
    row_errors = []

    for row_number, row in enumerate(reader, start=2):  # row 1 is the header
        normalized = {(key or "").strip().lower(): (value or "").strip() for key, value in row.items()}
        if not any(normalized.values()):
            continue  # skip blank trailing rows

        question_text = normalized.get("question_text", "")
        question_type = normalized.get("question_type", "").lower()
        correct_answer = normalized.get("correct_answer", "").upper()
        marks_raw = normalized.get("marks", "")

        if not question_text:
            row_errors.append(f"Row {row_number}: question_text is required")
            continue
        if question_type not in {"mcq", "true_false"}:
            row_errors.append(f"Row {row_number}: question_type must be 'mcq' or 'true_false'")
            continue
        if not correct_answer:
            row_errors.append(f"Row {row_number}: correct_answer is required")
            continue
        try:
            row_marks = int(marks_raw) if marks_raw else 1
        except ValueError:
            row_errors.append(f"Row {row_number}: marks must be a whole number")
            continue

        to_create.append(
            Question(
                exam_id=exam.exam_id,
                question_text=question_text,
                question_type=question_type,
                option_a=normalized.get("option_a") or None,
                option_b=normalized.get("option_b") or None,
                option_c=normalized.get("option_c") or None,
                option_d=normalized.get("option_d") or None,
                correct_answer=correct_answer,
                marks=row_marks,
                order_num=next_order,
            )
        )
        next_order += 1

    if not to_create:
        return jsonify(
            {
                "error": {"message": "No valid questions found in the CSV"},
                "row_errors": row_errors,
            }
        ), 400

    db.session.add_all(to_create)
    db.session.commit()

    return jsonify(
        {
            "message": f"{len(to_create)} question(s) added"
            + (f", {len(row_errors)} row(s) skipped" if row_errors else ""),
            "created_count": len(to_create),
            "skipped_count": len(row_errors),
            "row_errors": row_errors,
        }
    ), 201


@exams_bp.delete("/<int:exam_id>/questions/<int:question_id>")
@jwt_required()
def delete_question(exam_id, question_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    question = Question.query.filter_by(exam_id=exam_id, question_id=question_id).first()
    if not question:
        return jsonify({"error": {"message": "Question not found"}}), 404
    db.session.delete(question)
    db.session.commit()
    return jsonify({"message": "Question deleted"}), 200


@exams_bp.put("/<int:exam_id>/questions/<int:question_id>")
@jwt_required()
def update_question(exam_id, question_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    question = Question.query.filter_by(exam_id=exam_id, question_id=question_id).first()
    if not question:
        return jsonify({"error": {"message": "Question not found"}}), 404

    data = request.get_json(silent=True) or {}
    question_text = (data.get("question_text") or question.question_text).strip()
    question_type = (data.get("question_type") or question.question_type).strip().lower()
    correct_answer = (data.get("correct_answer") or question.correct_answer).strip().upper()
    marks = int(data.get("marks") or question.marks or 1)
    order_num = int(data.get("order_num") or question.order_num or 0)

    if not question_text or question_type not in {"mcq", "true_false"}:
        return jsonify({"error": {"message": "question_text and valid question_type are required"}}), 400
    if not correct_answer:
        return jsonify({"error": {"message": "correct_answer is required"}}), 400

    question.question_text = question_text
    question.question_type = question_type
    question.option_a = (data.get("option_a") or "").strip() or None
    question.option_b = (data.get("option_b") or "").strip() or None
    question.option_c = (data.get("option_c") or "").strip() or None
    question.option_d = (data.get("option_d") or "").strip() or None
    question.correct_answer = correct_answer
    question.marks = marks
    question.order_num = order_num
    db.session.commit()
    return jsonify({"message": "Question updated"}), 200


@exams_bp.get("/<int:exam_id>/students")
@jwt_required()
def list_exam_students(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    rows = (
        db.session.query(ExamSession, User)
        .join(User, User.user_id == ExamSession.student_id)
        .filter(ExamSession.exam_id == exam_id)
        .order_by(User.full_name.asc())
        .all()
    )
    total_marks = db.session.query(
        db.func.coalesce(db.func.sum(Question.marks), 0)
    ).filter(Question.exam_id == exam_id).scalar()

    return jsonify(
        {
            "students": [
                {
                    "user_id": user.user_id,
                    "full_name": user.full_name,
                    "registration_number": user.reg_number,
                    "email": user.email,
                    "session_id": session.session_id,
                    "session_status": session.session_status,
                    "score": float(session.score) if session.score is not None else None,
                    "total_marks": int(total_marks),
                    "warning_count": session.warning_count or 0,
                }
                for session, user in rows
            ]
        }
    ), 200


@exams_bp.get("/students/search")
@jwt_required()
def search_students_for_assignment():
    role = get_jwt().get("role")
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    query_text = (request.args.get("q") or "").strip()
    if len(query_text) < 2:
        return jsonify({"students": []}), 200

    pattern = f"%{query_text}%"
    rows = (
        User.query.filter(User.role == "student")
        .filter(
            db.or_(
                User.full_name.ilike(pattern),
                User.reg_number.ilike(pattern),
                User.email.ilike(pattern),
            )
        )
        .order_by(User.full_name.asc())
        .limit(20)
        .all()
    )
    return jsonify(
        {
            "students": [
                {
                    "user_id": user.user_id,
                    "full_name": user.full_name,
                    "registration_number": user.reg_number,
                    "email": user.email,
                    "department": user.department,
                }
                for user in rows
            ]
        }
    ), 200


@exams_bp.get("/<int:exam_id>/assigned-students")
@jwt_required()
def list_assigned_students(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    rows = (
        db.session.query(ExamStudentAssignment, User)
        .join(User, User.user_id == ExamStudentAssignment.student_id)
        .filter(ExamStudentAssignment.exam_id == exam_id)
        .order_by(User.full_name.asc())
        .all()
    )
    return jsonify(
        {
            "assigned_students": [
                {
                    "assignment_id": assignment.assignment_id,
                    "user_id": user.user_id,
                    "full_name": user.full_name,
                    "registration_number": user.reg_number,
                    "email": user.email,
                    "department": user.department,
                    "created_at": assignment.created_at.isoformat() if assignment.created_at else None,
                }
                for assignment, user in rows
            ]
        }
    ), 200


@exams_bp.post("/<int:exam_id>/assigned-students")
@jwt_required()
def assign_student_to_exam(exam_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403
    if role == "lecturer" and not _lecturer_profile_confirmed(user_id):
        return jsonify({"error": {"message": "Complete and confirm your lecturer profile before managing exams."}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    data = request.get_json(silent=True) or {}
    student_id = data.get("student_id")
    if not student_id:
        return jsonify({"error": {"message": "student_id is required"}}), 400

    student = db.session.get(User, int(student_id))
    if not student or student.role != "student":
        return jsonify({"error": {"message": "Student not found"}}), 404

    existing = ExamStudentAssignment.query.filter_by(exam_id=exam_id, student_id=student.user_id).first()
    if existing:
        return jsonify({"error": {"message": "Student is already assigned to this exam"}}), 409

    assignment = ExamStudentAssignment(exam_id=exam_id, student_id=student.user_id, added_by=user_id)
    db.session.add(assignment)
    db.session.commit()
    return jsonify({"assignment_id": assignment.assignment_id, "message": "Student assigned to exam"}), 201


@exams_bp.delete("/<int:exam_id>/assigned-students/<int:student_id>")
@jwt_required()
def unassign_student_from_exam(exam_id, student_id):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    exam = db.session.get(Exam, exam_id)
    if not exam:
        return jsonify({"error": {"message": "Exam not found"}}), 404
    if role == "lecturer" and exam.lecturer_id != user_id:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    assignment = ExamStudentAssignment.query.filter_by(exam_id=exam_id, student_id=student_id).first()
    if not assignment:
        return jsonify({"error": {"message": "Assignment not found"}}), 404
    db.session.delete(assignment)
    db.session.commit()
    return jsonify({"message": "Student removed from exam"}), 200


@exams_bp.get("/course/<string:course_code>/students")
@jwt_required()
def list_course_students(course_code: str):
    role = get_jwt().get("role")
    user_id = int(get_jwt_identity())
    if role not in {"lecturer", "admin"}:
        return jsonify({"error": {"message": "Forbidden"}}), 403

    exams_query = Exam.query.filter(Exam.course_code == course_code)
    if role == "lecturer":
        exams_query = exams_query.filter(Exam.lecturer_id == user_id)
    exams = exams_query.all()
    exam_ids = [exam.exam_id for exam in exams]
    if not exam_ids:
        return jsonify({"students": []}), 200

    distinct_students = (
        db.session.query(ExamSession.student_id.label("student_id"))
        .filter(ExamSession.exam_id.in_(exam_ids))
        .distinct()
        .subquery()
    )
    rows = (
        db.session.query(User.user_id, User.full_name, User.reg_number, User.email)
        .join(distinct_students, distinct_students.c.student_id == User.user_id)
        .order_by(User.full_name.asc())
        .all()
    )

    return jsonify(
        {
            "students": [
                {
                    "user_id": row.user_id,
                    "full_name": row.full_name,
                    "registration_number": row.reg_number,
                    "email": row.email,
                }
                for row in rows
            ]
        }
    ), 200
