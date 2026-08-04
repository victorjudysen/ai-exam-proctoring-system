"use client"

import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, BookOpenCheck, ClipboardList, Eye, EyeOff, FileQuestion, KeyRound, LogOut, ShieldAlert, UserCircle2, Users, X } from "lucide-react"
import Link from "next/link"
import { io } from "socket.io-client"
import { getApiPath, getSocketConnection } from "@/lib/api-url"
import { cn } from "@/lib/utils"
import { DashboardPanel, DashboardShell, MetricCard } from "@/components/dashboard-shell"
import { StatusBadge } from "@/components/status-badge"

type MeUser = {
  user_id: number
  full_name: string
  registration_number?: string
  email?: string
  phone_number?: string | null
  department?: string | null
  lecturer_profile_confirmed?: boolean
  must_change_password?: boolean
  role: string
}

type ProgramOption = {
  program_id: number
  name: string
}

type ExamRow = {
  exam_id: number
  title: string
  course_code: string
  duration_min: number
  scheduled_at?: string | null
  status: string
  programs?: ProgramOption[]
}

type StudentSearchRow = {
  user_id: number
  full_name: string
  registration_number: string
  email: string
  department?: string | null
}

type AssignedStudentRow = StudentSearchRow & {
  assignment_id: number
}

type QuestionRow = {
  question_id: number
  question_text: string
  question_type: string
  option_a?: string | null
  option_b?: string | null
  option_c?: string | null
  option_d?: string | null
  correct_answer?: string
  marks: number
  order_num: number
}

type StudentRow = {
  user_id: number
  full_name: string
  registration_number: string
  email: string
  session_status: string
  score?: number | null
  total_marks: number
  warning_count: number
}

type SessionResultRow = {
  session_id: number
  exam_id: number
  student_name: string
  registration_number: string
  student_email: string
  exam_title: string
  course_code: string
  session_status: string
  score?: number | null
  total_marks: number
  warning_count: number
  risk_level: string
}

type ReportLogEntry = {
  log_id: number
  event_type: string
  event_data: Record<string, unknown>
  logged_at: string | null
  is_suspicious?: boolean | null
  reviewed_by?: number | null
  reviewed_at?: string | null
}

type LiveAlert = {
  session_id: number
  log_id: number
  event_type: string
  event_data: Record<string, unknown>
  warning_count: number
  logged_at: string | null
  student_name: string
  exam_title: string
  is_suspicious?: boolean | null
}

type ReportDetail = {
  session_id: number
  student: { user_id: number; full_name: string; reg_number: string; email: string }
  exam: { exam_id: number; title: string; course_code: string }
  gaze_away_count: number
  head_turned_count: number
  tab_switch_count: number
  face_absent_count: number
  multiple_faces_count: number
  identity_mismatch_count: number
  total_anomalies: number
  risk_level: string
  score?: number | null
  total_marks: number
  warning_count?: number
  session_status?: string
  logs: ReportLogEntry[]
}

const LECTURER_DEPARTMENT_OPTIONS = [
  "CSE - Computer Science & Engineering",
  "ETE - Electronic & Telecommunication Engineering",
  "IST - Information System Technology",
]

function formatDateTime(value?: string | null) {
  if (!value) return "TBD"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "TBD"
  return date.toLocaleString()
}

function formatDateTimeInput(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const offsetMs = date.getTimezoneOffset() * 60 * 1000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16)
}

function toggleProgramId(list: number[], id: number): number[] {
  return list.includes(id) ? list.filter((existing) => existing !== id) : [...list, id]
}

// Human-readable label for every BehavioralLog/live-alert event_type this
// system produces (see backend/app/sessions/routes.py and
// ai-service/sockets/frame_handler.py for the full set of literal values).
// Falls back to a generic Title Case of the raw type for anything new that
// isn't mapped yet, so an unrecognized type never renders blank.
const EVENT_TYPE_LABELS: Record<string, string> = {
  gaze_away: "Gaze Away Detected",
  head_turned: "Head Turned Away",
  face_absent: "Student Face Missing",
  multiple_faces: "Multiple Faces Detected",
  identity_mismatch: "Identity Mismatch Detected",
  tab_switch: "Tab Switch Detected",
  identity_verification: "Identity Verification",
  lecturer_warning: "Lecturer Warning Sent",
  session_terminated: "Session Terminated",
}

function formatEventLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] || eventType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatEventDetail(entry: { event_type: string; event_data: Record<string, unknown> }): string {
  const data = entry.event_data || {}
  if (entry.event_type === "identity_verification") {
    const parts: string[] = []
    if (typeof data.match === "boolean") parts.push(data.match ? "matched" : "no match")
    if (typeof data.confidence_score === "number") parts.push(`confidence: ${data.confidence_score.toFixed(2)}`)
    return parts.join(", ")
  }
  if (entry.event_type === "identity_mismatch") {
    const parts: string[] = ["face did not match registered profile during exam"]
    if (typeof data.confidence_score === "number") parts.push(`confidence: ${data.confidence_score.toFixed(2)}`)
    return parts.join(", ")
  }
  if (entry.event_type === "multiple_faces") {
    return typeof data.face_count === "number" ? `${data.face_count} faces detected in frame` : ""
  }
  if (entry.event_type === "tab_switch") {
    const parts: string[] = []
    if (data.reason === "visibility_hidden") parts.push("switched away from the exam tab")
    else if (data.reason === "window_blur") parts.push("exam window lost focus")
    return parts.join(", ")
  }
  if (entry.event_type === "lecturer_warning" && typeof data.message === "string") {
    return `"${data.message}"`
  }
  if (entry.event_type === "session_terminated" && typeof data.reason === "string") {
    return data.reason
  }
  const parts: string[] = []
  if (typeof data.gaze_direction === "string") parts.push(`gaze: ${data.gaze_direction}`)
  if (typeof data.yaw === "number") parts.push(`yaw: ${data.yaw.toFixed(1)}`)
  if (typeof data.pitch === "number") parts.push(`pitch: ${data.pitch.toFixed(1)}`)
  return parts.join(" ")
}

function LecturerDashboardInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tab = (searchParams.get("tab") || "dashboard").toLowerCase()
  const tabTitleMap: Record<string, string> = {
    dashboard: "Dashboard",
    exams: "Exams",
    questions: "Questions",
    students: "Students",
    results: "Sessions & Reports",
    profile: "Profile",
  }
  const [token, setToken] = useState("")
  const [me, setMe] = useState<MeUser | null>(null)
  const [exams, setExams] = useState<ExamRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [profileMsg, setProfileMsg] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [department, setDepartment] = useState("")
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingSaving, setOnboardingSaving] = useState(false)
  const [onboardingMsg, setOnboardingMsg] = useState("")
  const [showForcePasswordModal, setShowForcePasswordModal] = useState(false)
  const [forcePasswordMsg, setForcePasswordMsg] = useState("")

  const [newTitle, setNewTitle] = useState("")
  const [newCourseCode, setNewCourseCode] = useState("")
  const [newDuration, setNewDuration] = useState("60")
  const [newSchedule, setNewSchedule] = useState("")
  const [newProgramIds, setNewProgramIds] = useState<number[]>([])
  const [editingExam, setEditingExam] = useState<ExamRow | null>(null)
  const [editTitle, setEditTitle] = useState("")
  const [editCourseCode, setEditCourseCode] = useState("")
  const [editDuration, setEditDuration] = useState("60")
  const [editSchedule, setEditSchedule] = useState("")
  const [editProgramIds, setEditProgramIds] = useState<number[]>([])
  const [savingExamEdit, setSavingExamEdit] = useState(false)
  const [programOptions, setProgramOptions] = useState<ProgramOption[]>([])

  const [selectedExamId, setSelectedExamId] = useState<number | null>(null)
  const [questions, setQuestions] = useState<QuestionRow[]>([])
  const [students, setStudents] = useState<StudentRow[]>([])
  const [assignedStudents, setAssignedStudents] = useState<AssignedStudentRow[]>([])
  const [studentSearchQuery, setStudentSearchQuery] = useState("")
  const [studentSearchResults, setStudentSearchResults] = useState<StudentSearchRow[]>([])
  const [searchingStudents, setSearchingStudents] = useState(false)
  const [assigningStudentId, setAssigningStudentId] = useState<number | null>(null)
  const [assignError, setAssignError] = useState("")
  const [sessionResults, setSessionResults] = useState<SessionResultRow[]>([])
  const [exportingAll, setExportingAll] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<number>>(new Set())
  const [viewingReport, setViewingReport] = useState<ReportDetail | null>(null)
  const [loadingReportId, setLoadingReportId] = useState<number | null>(null)
  const [reportError, setReportError] = useState("")
  const [liveAlerts, setLiveAlerts] = useState<LiveAlert[]>([])
  const [liveAlertsConnected, setLiveAlertsConnected] = useState(false)
  const [reviewingLogId, setReviewingLogId] = useState<number | null>(null)
  const [terminatingSession, setTerminatingSession] = useState<SessionResultRow | null>(null)
  const [terminationReason, setTerminationReason] = useState("Suspicious activity detected during your exam.")
  const [terminating, setTerminating] = useState(false)
  const [terminateError, setTerminateError] = useState("")
  const [warningTargetSession, setWarningTargetSession] = useState<SessionResultRow | null>(null)
  const [warningMessage, setWarningMessage] = useState("Your invigilator has flagged unusual activity. Please stay focused on your exam.")
  const [sendingWarning, setSendingWarning] = useState(false)
  const [warningSendError, setWarningSendError] = useState("")
  const sessionResultsRef = useRef<SessionResultRow[]>([])
  const [questionText, setQuestionText] = useState("")
  const [questionType, setQuestionType] = useState<"mcq" | "true_false">("mcq")
  const [optionA, setOptionA] = useState("")
  const [optionB, setOptionB] = useState("")
  const [optionC, setOptionC] = useState("")
  const [optionD, setOptionD] = useState("")
  const [correctAnswer, setCorrectAnswer] = useState("")
  const [marks, setMarks] = useState("1")
  const [editingQuestionId, setEditingQuestionId] = useState<number | null>(null)
  const [bulkUploadFile, setBulkUploadFile] = useState<File | null>(null)
  const [bulkUploading, setBulkUploading] = useState(false)
  const [bulkUploadMessage, setBulkUploadMessage] = useState("")
  const [bulkUploadErrors, setBulkUploadErrors] = useState<string[]>([])
  const bulkUploadInputRef = useRef<HTMLInputElement>(null)
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState("")
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    const rawToken = localStorage.getItem("token")
    if (!rawToken) {
      router.push("/unauthorized?reason=auth")
      return
    }
    document.cookie = `auth_token=${rawToken}; Path=/; Max-Age=${60 * 60 * 8}; SameSite=Lax`
    setToken(rawToken)
    void load(rawToken)
  }, [router])

  useEffect(() => {
    if (!token || exams.length === 0) return
    const requestedExamId = Number(searchParams.get("examId"))
    if (!Number.isFinite(requestedExamId) || requestedExamId <= 0) return
    if (requestedExamId === selectedExamId) return
    const picked = exams.find((row) => row.exam_id === requestedExamId)
    if (!picked) return
    setSelectedExamId(requestedExamId)
    void loadExamDetails(token, requestedExamId)
  }, [token, exams, searchParams, selectedExamId])

  useEffect(() => {
    setBulkUploadFile(null)
    setBulkUploadMessage("")
    setBulkUploadErrors([])
    if (bulkUploadInputRef.current) bulkUploadInputRef.current.value = ""
  }, [selectedExamId])

  async function load(activeToken: string) {
    setLoading(true)
    try {
      const [meRes, examsRes, sessionsRes, programsRes] = await Promise.all([
        fetch(getApiPath("/auth/me"), { headers: { Authorization: `Bearer ${activeToken}` } }),
        fetch(getApiPath("/exams"), { headers: { Authorization: `Bearer ${activeToken}` } }),
        fetch(getApiPath("/sessions"), { headers: { Authorization: `Bearer ${activeToken}` } }),
        fetch(getApiPath("/exams/programs"), { headers: { Authorization: `Bearer ${activeToken}` } }),
      ])
      const mePayload = await meRes.json().catch(() => ({}))
      const examsPayload = await examsRes.json().catch(() => ({}))
      const sessionsPayload = await sessionsRes.json().catch(() => ({}))
      const programsPayload = await programsRes.json().catch(() => ({}))
      if (programsRes.ok) setProgramOptions(programsPayload.programs || [])
      if (!meRes.ok) {
        localStorage.removeItem("token")
        localStorage.removeItem("user")
        router.push("/unauthorized?reason=auth")
        return
      }
      if (mePayload?.user?.role === "administrator" || mePayload?.user?.role === "admin") {
        router.push("/admin")
        return
      }
      if (mePayload?.user?.role !== "lecturer") {
        router.push("/unauthorized?reason=role")
        return
      }
      setMe(mePayload.user)
      setShowForcePasswordModal(Boolean(mePayload.user?.must_change_password))
      setEmail(mePayload.user?.email || "")
      setPhone(mePayload.user?.phone_number || "")
      setDepartment(mePayload.user?.department || "")
      const needsOnboarding =
        !Boolean(mePayload.user?.lecturer_profile_confirmed) ||
        !String(mePayload.user?.full_name || "").trim() ||
        !String(mePayload.user?.email || "").trim() ||
        !String(mePayload.user?.phone_number || "").trim() ||
        !String(mePayload.user?.department || "").trim()
      setShowOnboarding(Boolean(needsOnboarding))
      const rows = examsPayload.exams || []
      setExams(rows)
      setSessionResults(sessionsPayload.sessions || [])
      if (rows.length > 0) {
        const requestedExamId = Number(searchParams.get("examId"))
        const candidate = Number.isFinite(requestedExamId)
          ? rows.find((row: ExamRow) => row.exam_id === requestedExamId)
          : null
        const selected = candidate || rows[0]
        const selectedId = selected.exam_id
        setSelectedExamId(selectedId)
        await loadExamDetails(activeToken, selectedId)
      }
    } finally {
      setLoading(false)
    }
  }

  async function loadExamDetails(activeToken: string, examId: number) {
    const [examRes, studentsRes, assignedRes] = await Promise.all([
      fetch(getApiPath(`/exams/${examId}`), { headers: { Authorization: `Bearer ${activeToken}` } }),
      fetch(getApiPath(`/exams/${examId}/students`), { headers: { Authorization: `Bearer ${activeToken}` } }),
      fetch(getApiPath(`/exams/${examId}/assigned-students`), { headers: { Authorization: `Bearer ${activeToken}` } }),
    ])
    const examPayload = await examRes.json().catch(() => ({}))
    const studentsPayload = await studentsRes.json().catch(() => ({}))
    const assignedPayload = await assignedRes.json().catch(() => ({}))
    if (examRes.ok) setQuestions(examPayload.questions || [])
    if (studentsRes.ok) setStudents(studentsPayload.students || [])
    if (assignedRes.ok) setAssignedStudents(assignedPayload.assigned_students || [])
    setStudentSearchQuery("")
    setStudentSearchResults([])
    setAssignError("")
  }

  async function searchStudentsForAssignment() {
    const q = studentSearchQuery.trim()
    if (q.length < 2) {
      setStudentSearchResults([])
      return
    }
    setSearchingStudents(true)
    try {
      const res = await fetch(getApiPath(`/exams/students/search?q=${encodeURIComponent(q)}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await res.json().catch(() => ({}))
      if (res.ok) setStudentSearchResults(payload.students || [])
    } finally {
      setSearchingStudents(false)
    }
  }

  async function assignStudentToExam(student: StudentSearchRow) {
    if (!selectedExamId) return
    setAssigningStudentId(student.user_id)
    setAssignError("")
    const res = await fetch(getApiPath(`/exams/${selectedExamId}/assigned-students`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ student_id: student.user_id }),
    })
    const payload = await res.json().catch(() => ({}))
    setAssigningStudentId(null)
    if (!res.ok) {
      setAssignError(payload?.error?.message || "Could not assign student.")
      return
    }
    await loadExamDetails(token, selectedExamId)
  }

  async function removeAssignedStudent(studentId: number) {
    if (!selectedExamId) return
    const res = await fetch(getApiPath(`/exams/${selectedExamId}/assigned-students/${studentId}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setAssignError(payload?.error?.message || "Could not remove student.")
      return
    }
    await loadExamDetails(token, selectedExamId)
  }

  async function createExam() {
    if (!newTitle || !newCourseCode) return
    if (newProgramIds.length === 0) {
      setError("Select at least one degree program for this exam.")
      return
    }
    const res = await fetch(getApiPath("/exams"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title: newTitle,
        course_code: newCourseCode,
        duration_min: Number(newDuration),
        scheduled_at: newSchedule || undefined,
        program_ids: newProgramIds,
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(payload?.error?.message || "Could not create exam.")
      return
    }
    setNewTitle("")
    setNewCourseCode("")
    setNewDuration("60")
    setNewSchedule("")
    setNewProgramIds([])
    const createdExamId = Number(payload?.exam_id || payload?.id)
    if (Number.isFinite(createdExamId) && createdExamId > 0) {
      await load(token)
      router.push(`/lecturer?tab=questions&examId=${createdExamId}`)
      return
    }
    await load(token)
  }

  function openExamEditModal(exam: ExamRow) {
    setEditingExam(exam)
    setEditTitle(exam.title)
    setEditCourseCode(exam.course_code)
    setEditDuration(String(exam.duration_min))
    setEditSchedule(formatDateTimeInput(exam.scheduled_at))
    setEditProgramIds((exam.programs || []).map((program) => program.program_id))
    setError("")
  }

  function closeExamEditModal() {
    if (savingExamEdit) return
    setEditingExam(null)
    setEditTitle("")
    setEditCourseCode("")
    setEditDuration("60")
    setEditSchedule("")
    setEditProgramIds([])
  }

  async function saveExamEdit() {
    if (!editingExam) return
    const title = editTitle.trim()
    const courseCode = editCourseCode.trim()
    const duration = Number(editDuration)
    if (!title || !courseCode || !Number.isFinite(duration) || duration <= 0) {
      setError("Exam title, course code, and a valid duration are required.")
      return
    }
    if (editProgramIds.length === 0) {
      setError("Select at least one degree program for this exam.")
      return
    }

    setSavingExamEdit(true)
    const res = await fetch(getApiPath(`/exams/${editingExam.exam_id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        title,
        course_code: courseCode,
        duration_min: duration,
        scheduled_at: editSchedule || undefined,
        program_ids: editProgramIds,
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(payload?.error?.message || "Could not update exam.")
      setSavingExamEdit(false)
      return
    }
    const editedExamId = editingExam.exam_id
    setEditingExam(null)
    setSavingExamEdit(false)
    await load(token)
    setSelectedExamId(editedExamId)
    await loadExamDetails(token, editedExamId)
  }

  async function deleteExam(exam: ExamRow) {
    const ok = window.confirm(`Delete exam "${exam.title}"? This cannot be undone.`)
    if (!ok) return
    const res = await fetch(getApiPath(`/exams/${exam.exam_id}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(payload?.error?.message || "Could not delete exam.")
      return
    }
    if (selectedExamId === exam.exam_id) {
      setSelectedExamId(null)
      setQuestions([])
      setStudents([])
    }
    await load(token)
  }

  async function createQuestion() {
    if (!selectedExamId || !questionText || !correctAnswer) return
    const res = await fetch(getApiPath(`/exams/${selectedExamId}/questions`), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        question_text: questionText,
        question_type: questionType,
        option_a: optionA,
        option_b: optionB,
        option_c: optionC,
        option_d: optionD,
        correct_answer: correctAnswer,
        marks: Number(marks),
        order_num: questions.length + 1,
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(payload?.error?.message || "Could not create question.")
      return
    }
    setQuestionText("")
    setOptionA("")
    setOptionB("")
    setOptionC("")
    setOptionD("")
    setCorrectAnswer("")
    setMarks("1")
    await loadExamDetails(token, selectedExamId)
  }

  async function downloadQuestionTemplate() {
    const res = await fetch(getApiPath("/exams/questions/template"), {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      setError("Could not download the CSV template.")
      return
    }
    const blob = await res.blob()
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "question_upload_template.csv"
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  }

  async function uploadQuestionsCsv() {
    if (!selectedExamId || !bulkUploadFile) return
    setBulkUploading(true)
    setBulkUploadMessage("")
    setBulkUploadErrors([])
    try {
      const formData = new FormData()
      formData.append("file", bulkUploadFile)
      const res = await fetch(getApiPath(`/exams/${selectedExamId}/questions/bulk`), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(payload?.error?.message || "Could not upload the CSV file.")
        setBulkUploadErrors(payload?.row_errors || [])
        return
      }
      setBulkUploadMessage(payload.message || "Questions uploaded.")
      setBulkUploadErrors(payload.row_errors || [])
      setBulkUploadFile(null)
      if (bulkUploadInputRef.current) bulkUploadInputRef.current.value = ""
      await loadExamDetails(token, selectedExamId)
    } finally {
      setBulkUploading(false)
    }
  }

  async function updateExamStatus(examId: number, status: string) {
    const res = await fetch(getApiPath(`/exams/${examId}/status`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(payload?.error?.message || "Could not update exam status.")
      return
    }
    await load(token)
  }

  async function deleteQuestion(questionId: number) {
    if (!selectedExamId) return
    const res = await fetch(getApiPath(`/exams/${selectedExamId}/questions/${questionId}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) await loadExamDetails(token, selectedExamId)
  }

  async function saveQuestionEdit(question: QuestionRow) {
    if (!selectedExamId) return
    const updatedText = window.prompt("Update question text", question.question_text)
    if (!updatedText) return
    const updatedCorrect = window.prompt("Update correct answer", question.correct_answer || "")
    if (!updatedCorrect) return

    setEditingQuestionId(question.question_id)
    const res = await fetch(getApiPath(`/exams/${selectedExamId}/questions/${question.question_id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        question_text: updatedText,
        question_type: question.question_type,
        option_a: question.option_a || "",
        option_b: question.option_b || "",
        option_c: question.option_c || "",
        option_d: question.option_d || "",
        correct_answer: updatedCorrect,
        marks: question.marks,
        order_num: question.order_num,
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(payload?.error?.message || "Could not update question.")
      setEditingQuestionId(null)
      return
    }
    await loadExamDetails(token, selectedExamId)
    setEditingQuestionId(null)
  }

  const selectedExam = useMemo(
    () => exams.find(e => e.exam_id === selectedExamId) || null,
    [exams, selectedExamId]
  )
  const filteredSessionResults = useMemo(() => {
    if (!selectedExamId) return sessionResults
    return sessionResults.filter((row) => row.exam_id === selectedExamId)
  }, [selectedExamId, sessionResults])

  useEffect(() => {
    sessionResultsRef.current = sessionResults
  }, [sessionResults])

  // Live suspicious-activity feed for the Sessions & Reports tab: subscribes
  // to every session currently in view via the AI service's Socket.IO
  // server (the only process holding a live connection to each student's
  // browser - see ai-service/app.py::/internal/broadcast), so a new
  // behavioural log or a termination shows up immediately instead of only
  // after a manual refresh.
  const visibleSessionIds = filteredSessionResults.map((row) => row.session_id).join(",")
  useEffect(() => {
    if (tab !== "results" || !token || !visibleSessionIds) {
      setLiveAlertsConnected(false)
      return
    }

    const { url: wsUrl, path: socketPath } = getSocketConnection()
    const socket = io(wsUrl, { path: socketPath, transports: ["websocket", "polling"] })

    socket.on("connect", () => {
      setLiveAlertsConnected(true)
      for (const idString of visibleSessionIds.split(",")) {
        socket.emit("join_session_room", { session_id: Number(idString), token })
      }
    })
    socket.on("disconnect", () => setLiveAlertsConnected(false))

    socket.on(
      "lecturer_alert",
      (event: {
        session_id: number
        log_id: number
        event_type: string
        event_data?: Record<string, unknown> | null
        warning_count: number
        logged_at: string | null
      }) => {
        setSessionResults((prev) =>
          prev.map((row) =>
            row.session_id === event.session_id
              ? {
                  ...row,
                  warning_count: event.warning_count,
                  risk_level: event.warning_count >= 3 ? "high" : event.warning_count > 1 ? "medium" : "low",
                }
              : row
          )
        )
        const row = sessionResultsRef.current.find((r) => r.session_id === event.session_id)
        setLiveAlerts((prev) => [
          {
            session_id: event.session_id,
            log_id: event.log_id,
            event_type: event.event_type,
            event_data: event.event_data || {},
            warning_count: event.warning_count,
            logged_at: event.logged_at,
            student_name: row?.student_name ?? `Session #${event.session_id}`,
            exam_title: row?.exam_title ?? "",
            is_suspicious: null,
          },
          ...prev,
        ].slice(0, 30))
      }
    )

    socket.on("session_terminated", (event: { session_id: number; score?: number }) => {
      setSessionResults((prev) =>
        prev.map((row) =>
          row.session_id === event.session_id
            ? { ...row, session_status: "terminated", score: event.score ?? row.score }
            : row
        )
      )
    })

    return () => {
      socket.disconnect()
      setLiveAlertsConnected(false)
    }
  }, [tab, token, visibleSessionIds])

  async function reviewLog(logId: number, isSuspicious: boolean) {
    setReviewingLogId(logId)
    try {
      const res = await fetch(getApiPath(`/reports/logs/${logId}/review`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_suspicious: isSuspicious }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) return
      setLiveAlerts((prev) =>
        prev.map((alert) => (alert.log_id === logId ? { ...alert, is_suspicious: payload.is_suspicious } : alert))
      )
      setViewingReport((prev) =>
        prev
          ? {
              ...prev,
              logs: prev.logs.map((log) =>
                log.log_id === logId
                  ? { ...log, is_suspicious: payload.is_suspicious, reviewed_by: payload.reviewed_by, reviewed_at: payload.reviewed_at }
                  : log
              ),
            }
          : prev
      )
    } finally {
      setReviewingLogId(null)
    }
  }

  // The reason shown to the student is derived from the specific
  // behavioural event the lecturer was looking at when they decided to
  // terminate, rather than a generic boilerplate message - the student
  // should be told what was actually observed, not just "suspicious
  // activity".
  function defaultTerminationReason(eventType?: string): string {
    if (!eventType) return "Suspicious activity detected during your exam."
    return `Your exam session was terminated due to: ${formatEventLabel(eventType)}.`
  }

  function openTerminateModal(row: SessionResultRow, eventType?: string) {
    setTerminateError("")
    setTerminationReason(defaultTerminationReason(eventType))
    setTerminatingSession(row)
  }

  async function confirmTerminateSession() {
    if (!terminatingSession) return
    setTerminating(true)
    setTerminateError("")
    try {
      const res = await fetch(getApiPath(`/sessions/${terminatingSession.session_id}/terminate`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reason: terminationReason }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setTerminateError(payload?.error?.message || "Could not terminate session.")
        return
      }
      setSessionResults((prev) =>
        prev.map((row) =>
          row.session_id === terminatingSession.session_id
            ? { ...row, session_status: "terminated", score: payload.score ?? row.score }
            : row
        )
      )
      setTerminatingSession(null)
    } finally {
      setTerminating(false)
    }
  }

  function openWarningModal(row: SessionResultRow) {
    setWarningSendError("")
    setWarningMessage("Your invigilator has flagged unusual activity. Please stay focused on your exam.")
    setWarningTargetSession(row)
  }

  // A step short of terminate: pushes a real-time message to the student
  // without ending their session, so a lecturer watching warning_count
  // climb on a session can intervene before deciding termination is
  // warranted.
  async function confirmSendWarning() {
    if (!warningTargetSession) return
    setSendingWarning(true)
    setWarningSendError("")
    try {
      const res = await fetch(getApiPath(`/sessions/${warningTargetSession.session_id}/warn`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: warningMessage }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setWarningSendError(payload?.error?.message || "Could not send warning.")
        return
      }
      setSessionResults((prev) =>
        prev.map((row) =>
          row.session_id === warningTargetSession.session_id
            ? {
                ...row,
                warning_count: payload.warning_count,
                risk_level: payload.warning_count >= 3 ? "high" : payload.warning_count > 1 ? "medium" : "low",
              }
            : row
        )
      )
      setWarningTargetSession(null)
    } finally {
      setSendingWarning(false)
    }
  }

  async function exportAllReports() {
    setExportingAll(true)
    try {
      const res = await fetch(getApiPath("/reports/export"), {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        setError(payload?.error?.message || "Failed to export reports.")
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `all_exam_reports_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExportingAll(false)
    }
  }

  function toggleSessionSelected(sessionId: number) {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  function toggleSelectAllSessions(rows: SessionResultRow[]) {
    setSelectedSessionIds((prev) => {
      const allSelected = rows.length > 0 && rows.every((row) => prev.has(row.session_id))
      if (allSelected) return new Set()
      return new Set(rows.map((row) => row.session_id))
    })
  }

  function exportSelectedSessionsCsv(rows: SessionResultRow[]) {
    const selectedRows = rows.filter((row) => selectedSessionIds.has(row.session_id))
    if (selectedRows.length === 0) return
    const header = [
      "session_id",
      "student_name",
      "reg_number",
      "course_code",
      "exam_title",
      "status",
      "score",
      "total_marks",
      "warning_count",
      "risk_level",
    ]
    const csvRows = selectedRows.map((row) => [
      row.session_id,
      row.student_name,
      row.registration_number,
      row.course_code,
      row.exam_title,
      row.session_status,
      row.score ?? "",
      row.total_marks,
      row.warning_count,
      row.risk_level,
    ])
    const csv = [header, ...csvRows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `selected_sessions_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function openReport(sessionId: number) {
    setReportError("")
    setLoadingReportId(sessionId)
    try {
      const res = await fetch(getApiPath(`/reports/${sessionId}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setReportError(payload?.error?.message || "Could not load report.")
        return
      }
      setViewingReport(payload.report)
    } finally {
      setLoadingReportId(null)
    }
  }

  async function selectExam(nextExamId: number, targetTab: string) {
    if (!Number.isFinite(nextExamId) || nextExamId <= 0) return
    setSelectedExamId(nextExamId)
    await loadExamDetails(token, nextExamId)
    router.push(`/lecturer?tab=${targetTab}&examId=${nextExamId}`)
  }

  function renderExamPicker(targetTab: string) {
    return (
      <div className="mb-4">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Select Exam
        </label>
        <select
          value={selectedExamId ?? ""}
          onChange={(e) => void selectExam(Number(e.target.value), targetTab)}
          className="w-full max-w-md rounded-md border border-border bg-background p-2 text-sm text-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
        >
          {exams.length === 0 ? <option value="">No exams available</option> : null}
          {exams.map((exam) => (
            <option key={exam.exam_id} value={exam.exam_id}>
              {exam.title} - {exam.course_code} ({exam.status})
            </option>
          ))}
        </select>
      </div>
    )
  }

  function renderBulkUploadPanel(targetTab: string, showPicker: boolean) {
    return (
      <div className="rounded-xl border border-dashed border-border p-4">
        <p className="text-sm font-semibold text-foreground">Bulk upload questions via CSV</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Download the template below and fill it in without renaming or reordering the columns — this keeps
          every lecturer&apos;s file in the same shape so uploads never fail on mismatched columns.
        </p>
        {showPicker && <div className="mt-3">{renderExamPicker(targetTab)}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={downloadQuestionTemplate}
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
          >
            Download CSV Template
          </button>
          <input
            ref={bulkUploadInputRef}
            type="file"
            accept=".csv"
            onChange={e => setBulkUploadFile(e.target.files?.[0] || null)}
            className="text-sm text-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
          />
          <button
            onClick={uploadQuestionsCsv}
            disabled={!selectedExamId || !bulkUploadFile || bulkUploading}
            className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#142145] disabled:opacity-60"
          >
            {bulkUploading ? "Uploading..." : "Upload CSV"}
          </button>
        </div>
        {!selectedExamId && (
          <p className="mt-2 text-xs text-muted-foreground">Select an exam above before uploading.</p>
        )}
        {bulkUploadMessage && <p className="mt-2 text-sm text-green-700">{bulkUploadMessage}</p>}
        {bulkUploadErrors.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-xs text-amber-700">
            {bulkUploadErrors.map((rowError, index) => (
              <li key={index}>{rowError}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  async function changePassword() {
    setPasswordMsg("")
    setForcePasswordMsg("")
    if (!currentPassword || !newPassword) {
      setPasswordMsg("Current and new password are required.")
      return
    }
    if (newPassword.length < 8) {
      setPasswordMsg("New password must be at least 8 characters.")
      return
    }
    setSavingPassword(true)
    try {
      const res = await fetch(getApiPath("/auth/change-password"), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = payload?.error?.message || "Could not update password."
        setPasswordMsg(message)
        setForcePasswordMsg(message)
        return
      }
      setCurrentPassword("")
      setNewPassword("")
      setPasswordMsg("Password updated successfully.")
      setForcePasswordMsg("Password updated successfully.")
      setShowForcePasswordModal(false)
      setMe((prev) => (prev ? { ...prev, must_change_password: false } : prev))
    } finally {
      setSavingPassword(false)
    }
  }

  async function updateProfile(confirmProfile = false) {
    setProfileMsg("")
    setOnboardingMsg("")
    const res = await fetch(getApiPath("/users/profile"), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        email,
        phone_number: phone,
        department,
        confirm_profile: confirmProfile,
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      const message = payload?.error?.message || "Could not update profile."
      setProfileMsg(message)
      setOnboardingMsg(message)
      return false
    }
    if (payload?.user) {
      setMe(payload.user)
      localStorage.setItem("user", JSON.stringify(payload.user))
    }
    setProfileMsg("Profile updated successfully.")
    return true
  }

  async function submitOnboarding() {
    if (!String(email || "").trim()) return setOnboardingMsg("Email is required.")
    if (!String(phone || "").trim()) return setOnboardingMsg("Phone number is required.")
    if (!String(department || "").trim()) return setOnboardingMsg("Department is required.")
    setOnboardingSaving(true)
    try {
      const ok = await updateProfile(true)
      if (ok) setShowOnboarding(false)
    } finally {
      setOnboardingSaving(false)
    }
  }

  async function logout() {
    setIsExiting(true)
    await new Promise((r) => setTimeout(r, 350))
    localStorage.removeItem("token")
    localStorage.removeItem("user")
    localStorage.removeItem("session_id")
    localStorage.removeItem("exam_id")
    localStorage.removeItem("verified_session_id")
    document.cookie = "auth_token=; Path=/; Max-Age=0; SameSite=Lax"
    router.push("/")
  }

  return (
    <>
    <DashboardShell
      appName="ProctorAI Lecturer"
      title={tabTitleMap[tab] || "Lecturer Dashboard"}
      subtitle={me?.full_name || ""}
      avatarName={me?.full_name}
      sidebarItems={[
        { label: "Dashboard", href: "/lecturer", active: tab === "dashboard" },
        { label: "Exams", href: "/lecturer?tab=exams", active: tab === "exams" },
        { label: "Questions", href: "/lecturer?tab=questions", active: tab === "questions" },
        { label: "Students", href: "/lecturer?tab=students", active: tab === "students" },
        { label: "Sessions & Reports", href: "/lecturer?tab=results", active: tab === "results" },
        { label: "Profile", href: "/lecturer?tab=profile", active: tab === "profile" },
      ]}
      rightTopSlot={
        <div className="flex items-center gap-2">
          <button onClick={logout} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground">
            <LogOut className="h-4 w-4" /> Logout
          </button>
        </div>
      }
      isExiting={isExiting}
      exitMessage="Signing out of lecturer account..."
    >
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loading ? (
        <DashboardPanel title="Loading Lecturer Dashboard">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Preparing your dashboard...
          </div>
        </DashboardPanel>
      ) : null}

      {!loading ? (
      <>
        {tab === "dashboard" && (
          <>
        <section className="grid gap-3 md:grid-cols-3">
          <MetricCard label="My Exams" value={exams.length} />
          <MetricCard label="Questions (Selected Exam)" value={questions.length} />
          <MetricCard label="Students (Selected Exam)" value={students.length} />
        </section>
        <DashboardPanel title="Quick Shortcuts" subtitle="Move quickly between lecturer workflows.">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Link href="/lecturer?tab=exams" className="rounded-xl border border-border bg-gradient-to-br from-blue-50 to-indigo-50 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
              <BookOpenCheck className="h-5 w-5 text-[#1a2d5a]" />
              <p className="mt-2 text-sm font-semibold text-foreground">Exams</p>
              <p className="mt-1 text-xs text-muted-foreground">Create and manage exams.</p>
            </Link>
            <Link href="/lecturer?tab=questions" className="rounded-xl border border-border bg-gradient-to-br from-emerald-50 to-teal-50 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
              <FileQuestion className="h-5 w-5 text-emerald-700" />
              <p className="mt-2 text-sm font-semibold text-foreground">Questions</p>
              <p className="mt-1 text-xs text-muted-foreground">Build question banks.</p>
            </Link>
            <Link href="/lecturer?tab=students" className="rounded-xl border border-border bg-gradient-to-br from-amber-50 to-orange-50 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
              <Users className="h-5 w-5 text-amber-700" />
              <p className="mt-2 text-sm font-semibold text-foreground">Students</p>
              <p className="mt-1 text-xs text-muted-foreground">View enrolled students.</p>
            </Link>
            <Link href="/lecturer?tab=results" className="rounded-xl border border-border bg-gradient-to-br from-violet-50 to-fuchsia-50 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
              <ClipboardList className="h-5 w-5 text-violet-700" />
              <p className="mt-2 text-sm font-semibold text-foreground">Sessions & Reports</p>
              <p className="mt-1 text-xs text-muted-foreground">Inspect outcomes and risk.</p>
            </Link>
            <Link href="/lecturer?tab=profile" className="rounded-xl border border-border bg-gradient-to-br from-slate-100 to-slate-200 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
              <UserCircle2 className="h-5 w-5 text-slate-700" />
              <p className="mt-2 text-sm font-semibold text-foreground">Profile</p>
              <p className="mt-1 text-xs text-muted-foreground">Reset account password.</p>
            </Link>
          </div>
        </DashboardPanel>
          </>
        )}

        {tab === "exams" && (
          <>
        <DashboardPanel title="Create Exam" subtitle="Set the title, schedule, and eligible degree programs, then add questions — publish it once you're ready for students to see it.">
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Exam title" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />
            <input value={newCourseCode} onChange={e => setNewCourseCode(e.target.value)} placeholder="Course code" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />
            <input value={newDuration} onChange={e => setNewDuration(e.target.value)} placeholder="Duration minutes" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />
            <input
              type="datetime-local"
              value={newSchedule}
              onChange={e => setNewSchedule(e.target.value)}
              onClick={(e) => {
                const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void }
                el.showPicker?.()
              }}
              className="cursor-pointer rounded-md border border-border bg-background p-2 text-sm text-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div className="mt-3">
            <p className="text-sm font-medium text-foreground">Degree programs eligible for this exam <span className="text-red-600">*</span></p>
            <p className="text-xs text-muted-foreground">Only students in the selected program(s) will see this exam. Add exceptions later from the Students tab.</p>
            <div className="mt-2 grid max-h-48 gap-1.5 overflow-y-auto rounded-md border border-border p-2 md:grid-cols-2">
              {programOptions.map((program) => (
                <label key={program.program_id} className="flex items-start gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={newProgramIds.includes(program.program_id)}
                    onChange={() => setNewProgramIds((prev) => toggleProgramId(prev, program.program_id))}
                    className="mt-0.5"
                  />
                  {program.name}
                </label>
              ))}
              {programOptions.length === 0 && <p className="text-xs text-muted-foreground">Loading degree programs...</p>}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Workflow: create exam, add questions immediately, then set exam status to <span className="font-semibold">scheduled</span> or <span className="font-semibold">live</span>.
          </p>
          <button onClick={createExam} className="mt-3 rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#142145]">Create Exam & Add Questions</button>
        </DashboardPanel>

        <DashboardPanel title="Add Questions in Bulk" subtitle="Download the template, fill it in, and upload it — no need to add questions one at a time.">
          {renderBulkUploadPanel("exams", true)}
        </DashboardPanel>

        <DashboardPanel title="My Exam List" subtitle="Review every exam you've created, update its status, or open it to manage questions and students — all from one table.">
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left">
                  <th className="py-2 pl-3">Title</th>
                  <th>Course</th>
                  <th>Programs</th>
                  <th>Schedule</th>
                  <th>Status</th>
                  <th>Set Status</th>
                  <th>Exams</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {exams.map((exam) => (
                  <tr key={exam.exam_id} className="border-b last:border-b-0">
                    <td className="py-2 pl-3 font-medium">{exam.title}</td>
                    <td>{exam.course_code}</td>
                    <td className="max-w-[220px]">
                      {(exam.programs || []).length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {(exam.programs || []).map((program) => (
                            <span key={program.program_id} className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {program.name.length > 28 ? `${program.name.slice(0, 28)}...` : program.name}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">All programs (legacy)</span>
                      )}
                    </td>
                    <td>{formatDateTime(exam.scheduled_at)}</td>
                    <td><StatusBadge value={exam.status} /></td>
                    <td>
                      <select
                        className="rounded-md border border-border bg-background p-1 text-xs text-foreground focus:border-[#1a2d5a] focus:outline-none"
                        value={exam.status}
                        onChange={async (e) => updateExamStatus(exam.exam_id, e.target.value)}
                      >
                        <option value="draft">draft</option>
                        <option value="scheduled">scheduled</option>
                        <option value="live">live</option>
                        <option value="completed">completed</option>
                      </select>
                    </td>
                    <td>
                      <button
                        onClick={async () => {
                          setSelectedExamId(exam.exam_id)
                          await loadExamDetails(token, exam.exam_id)
                          router.push(`/lecturer?tab=questions&examId=${exam.exam_id}`)
                        }}
                        className="mr-2 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        Exams
                      </button>
                      <button
                        onClick={() => openExamEditModal(exam)}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        Edit
                      </button>
                    </td>
                    <td>
                      <button onClick={() => deleteExam(exam)} className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {exams.length === 0 && <tr><td colSpan={8} className="py-3 pl-3 text-slate-600">No exams created yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
          </>
        )}

        {tab === "questions" && (
        <DashboardPanel title={`Question Builder ${selectedExam ? `- ${selectedExam.title}` : ""}`}>
          {renderExamPicker("questions")}
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <select value={questionType} onChange={e => setQuestionType(e.target.value as "mcq" | "true_false")} className="rounded-md border border-border bg-background p-2 text-sm text-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100">
              <option value="mcq">mcq</option>
              <option value="true_false">true_false</option>
            </select>
            <input value={marks} onChange={e => setMarks(e.target.value)} placeholder="Marks" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />
            <input value={questionText} onChange={e => setQuestionText(e.target.value)} placeholder="Question text" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100 md:col-span-2" />
            <input value={optionA} onChange={e => setOptionA(e.target.value)} placeholder="Option A" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />
            <input value={optionB} onChange={e => setOptionB(e.target.value)} placeholder="Option B" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />
            {questionType === "mcq" && <input value={optionC} onChange={e => setOptionC(e.target.value)} placeholder="Option C" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />}
            {questionType === "mcq" && <input value={optionD} onChange={e => setOptionD(e.target.value)} placeholder="Option D" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100" />}
            <input value={correctAnswer} onChange={e => setCorrectAnswer(e.target.value)} placeholder="Correct answer (e.g. A or TRUE)" className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100 md:col-span-2" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={createQuestion} disabled={!selectedExamId} className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#142145] disabled:opacity-60">
              Add Question
            </button>
            {selectedExam && selectedExam.status !== "live" && selectedExam.status !== "completed" && (
              <button
                onClick={async () => {
                  const ok = window.confirm(
                    `Publish "${selectedExam.title}" to students now? They will be able to start the exam immediately.`
                  )
                  if (!ok) return
                  await updateExamStatus(selectedExam.exam_id, "live")
                }}
                disabled={questions.length === 0}
                title={questions.length === 0 ? "Add at least one question before publishing" : undefined}
                className="rounded-md border border-green-600 bg-green-50 px-4 py-2 text-sm font-semibold text-green-700 transition hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Publish Exam to Students
              </button>
            )}
            {selectedExam && selectedExam.status === "live" && (
              <span className="rounded-full border border-green-600 bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
                Published — live for students
              </span>
            )}
          </div>

          <div className="mt-6">{renderBulkUploadPanel("questions", false)}</div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2">#</th>
                  <th>Question</th>
                  <th>Type</th>
                  <th>Correct</th>
                  <th>Marks</th>
                  <th>Edit</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.question_id} className="border-b">
                    <td className="py-2">{q.order_num}</td>
                    <td>{q.question_text}</td>
                    <td>{q.question_type}</td>
                    <td>{q.correct_answer}</td>
                    <td>{q.marks}</td>
                    <td>
                      <button
                        onClick={() => saveQuestionEdit(q)}
                        disabled={editingQuestionId === q.question_id}
                        className="rounded border px-2 py-1 text-xs disabled:opacity-60"
                      >
                        {editingQuestionId === q.question_id ? "Saving..." : "Edit"}
                      </button>
                    </td>
                    <td><button onClick={() => deleteQuestion(q.question_id)} className="rounded border px-2 py-1 text-xs">Delete</button></td>
                  </tr>
                ))}
                {questions.length === 0 && <tr><td colSpan={7} className="py-3 text-slate-600">No questions for selected exam.</td></tr>}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
        )}

        {tab === "students" && (
          <>
        <DashboardPanel title={`Students In Course ${selectedExam ? `- ${selectedExam.course_code}` : ""}`}>
          {renderExamPicker("students")}
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-blue-700" />
            <h2 className="text-base font-semibold">Students In Course {selectedExam ? `- ${selectedExam.course_code}` : ""}</h2>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2">Name</th>
                  <th>Reg Number</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.user_id} className="border-b">
                    <td className="py-2">{s.full_name}</td>
                    <td>{s.registration_number}</td>
                    <td>{s.email}</td>
                    <td><StatusBadge value={s.session_status} /></td>
                    <td>{s.score != null ? `${s.score}/${s.total_marks}` : "-"}</td>
                    <td>{s.warning_count}</td>
                  </tr>
                ))}
                {students.length === 0 && <tr><td colSpan={6} className="py-3 text-slate-600">No students enrolled yet (students appear after starting session).</td></tr>}
              </tbody>
            </table>
          </div>
        </DashboardPanel>

        <DashboardPanel title="Manually Assign Students">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-blue-700" />
            <h2 className="text-base font-semibold">Manually Assign Students {selectedExam ? `- ${selectedExam.title}` : ""}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Grant a specific student access to this exam even if they are not in one of the exam&apos;s assigned degree programs (e.g. a special case or retake).
          </p>
          {assignError ? <p className="mt-2 text-sm text-red-600">{assignError}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={studentSearchQuery}
              onChange={(e) => setStudentSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void searchStudentsForAssignment()
                }
              }}
              placeholder="Search by name, reg number, or email"
              disabled={!selectedExamId}
              className="min-w-[240px] flex-1 rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            <button
              onClick={() => void searchStudentsForAssignment()}
              disabled={!selectedExamId || searchingStudents}
              className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
            >
              {searchingStudents ? "Searching..." : "Search"}
            </button>
          </div>
          {studentSearchResults.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left">
                    <th className="py-2 pl-2">Name</th>
                    <th>Reg Number</th>
                    <th>Email</th>
                    <th>Degree Program</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {studentSearchResults.map((s) => {
                    const alreadyAssigned = assignedStudents.some((a) => a.user_id === s.user_id)
                    return (
                      <tr key={s.user_id} className="border-b last:border-b-0">
                        <td className="py-2 pl-2">{s.full_name}</td>
                        <td>{s.registration_number}</td>
                        <td>{s.email}</td>
                        <td>{s.department || "-"}</td>
                        <td className="py-1 pr-2 text-right">
                          <button
                            onClick={() => void assignStudentToExam(s)}
                            disabled={alreadyAssigned || assigningStudentId === s.user_id}
                            className="rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
                          >
                            {alreadyAssigned ? "Assigned" : assigningStudentId === s.user_id ? "Adding..." : "Add"}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2">Name</th>
                  <th>Reg Number</th>
                  <th>Email</th>
                  <th>Degree Program</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {assignedStudents.map((a) => (
                  <tr key={a.assignment_id} className="border-b">
                    <td className="py-2">{a.full_name}</td>
                    <td>{a.registration_number}</td>
                    <td>{a.email}</td>
                    <td>{a.department || "-"}</td>
                    <td className="py-1 text-right">
                      <button
                        onClick={() => void removeAssignedStudent(a.user_id)}
                        className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {assignedStudents.length === 0 && <tr><td colSpan={5} className="py-3 text-slate-600">No manually assigned students for this exam.</td></tr>}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
          </>
        )}

        {tab === "results" && (
        <>
        <DashboardPanel title="Live Suspicious Activity">
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 rounded-full", liveAlertsConnected ? "bg-emerald-500" : "bg-amber-400")} />
            {liveAlertsConnected ? "Connected — new anomalies appear here in real time" : "Connecting..."}
          </div>
          <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/60">
                <tr className="border-b text-left">
                  <th className="py-2 pl-2">Time</th>
                  <th>Student</th>
                  <th>Exam</th>
                  <th>Event</th>
                  <th>Warnings</th>
                  <th>Decision</th>
                  <th className="pr-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {liveAlerts.map((alert) => {
                  const alertSession = sessionResults.find((row) => row.session_id === alert.session_id)
                  const canTerminate = alertSession && ["active", "pending"].includes((alertSession.session_status || "").toLowerCase())
                  return (
                  <tr key={alert.log_id} className="border-b last:border-b-0">
                    <td className="py-1.5 pl-2 whitespace-nowrap text-muted-foreground">
                      {alert.logged_at ? new Date(alert.logged_at).toLocaleTimeString() : "—"}
                    </td>
                    <td className="whitespace-nowrap">{alert.student_name}</td>
                    <td className="whitespace-nowrap">{alert.exam_title}</td>
                    <td>
                      <span className="font-medium text-foreground">{formatEventLabel(alert.event_type)}</span>
                      {formatEventDetail(alert) && (
                        <span className="block text-[11px] text-muted-foreground">{formatEventDetail(alert)}</span>
                      )}
                    </td>
                    <td>{alert.warning_count}</td>
                    <td>
                      {alert.is_suspicious === null || alert.is_suspicious === undefined ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => void reviewLog(alert.log_id, true)}
                            disabled={reviewingLogId === alert.log_id}
                            className="rounded border border-red-300 px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                          >
                            Suspicious
                          </button>
                          <button
                            onClick={() => void reviewLog(alert.log_id, false)}
                            disabled={reviewingLogId === alert.log_id}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-60"
                          >
                            Not Suspicious
                          </button>
                        </div>
                      ) : (
                        <span className={cn("text-[11px] font-medium", alert.is_suspicious ? "text-red-600" : "text-muted-foreground")}>
                          {alert.is_suspicious ? "Marked suspicious" : "Dismissed"}
                        </span>
                      )}
                    </td>
                    <td className="pr-2">
                      {canTerminate && alertSession ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => openWarningModal(alertSession)}
                            className="flex items-center gap-1 whitespace-nowrap rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-50"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Warn
                          </button>
                          <button
                            onClick={() => openTerminateModal(alertSession, alert.event_type)}
                            className="flex items-center gap-1 whitespace-nowrap rounded border border-red-300 px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
                          >
                            <ShieldAlert className="h-3 w-3" />
                            Terminate
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                  )
                })}
                {liveAlerts.length === 0 && (
                  <tr><td colSpan={7} className="py-3 text-center text-muted-foreground">No suspicious activity reported yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
        <DashboardPanel title={`Sessions ${selectedExam ? `- ${selectedExam.title}` : ""}`}>
          <p className="mt-1 text-xs text-muted-foreground">
            One row per exam attempt. Click &quot;View Report&quot; on a completed session for a detailed breakdown of what happened during AI monitoring.
          </p>
          {renderExamPicker("results")}
          {reportError ? <p className="mt-2 text-sm text-red-600">{reportError}</p> : null}
          <div className="mt-3 flex gap-2">
            <button
              onClick={exportAllReports}
              disabled={exportingAll}
              className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#142145] disabled:opacity-60"
            >
              {exportingAll ? "Exporting..." : "Export All Sessions CSV"}
            </button>
            <button
              onClick={() => exportSelectedSessionsCsv(filteredSessionResults)}
              disabled={selectedSessionIds.size === 0}
              className="rounded-md border border-[#1a2d5a] px-4 py-2 text-sm font-semibold text-[#1a2d5a] transition hover:bg-[#1a2d5a]/5 disabled:opacity-60"
            >
              Export Selected Sessions CSV{selectedSessionIds.size > 0 ? ` (${selectedSessionIds.size})` : ""}
            </button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={filteredSessionResults.length > 0 && filteredSessionResults.every((row) => selectedSessionIds.has(row.session_id))}
                      onChange={() => toggleSelectAllSessions(filteredSessionResults)}
                      aria-label="Select all sessions"
                    />
                  </th>
                  <th className="py-2">Student</th>
                  <th>Reg Number</th>
                  <th>Course</th>
                  <th>Exam</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Warnings</th>
                  <th>Risk</th>
                  <th>Report</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredSessionResults.map((row) => (
                  <tr key={row.session_id} className="border-b">
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={selectedSessionIds.has(row.session_id)}
                        onChange={() => toggleSessionSelected(row.session_id)}
                        aria-label={`Select session for ${row.student_name}`}
                      />
                    </td>
                    <td className="py-2">{row.student_name}</td>
                    <td>{row.registration_number}</td>
                    <td>{row.course_code}</td>
                    <td>{row.exam_title}</td>
                    <td><StatusBadge value={row.session_status} /></td>
                    <td>{row.score != null ? `${row.score}/${row.total_marks}` : "-"}</td>
                    <td>{row.warning_count}</td>
                    <td><StatusBadge value={row.risk_level} /></td>
                    <td>
                      <button
                        onClick={() => void openReport(row.session_id)}
                        disabled={loadingReportId === row.session_id}
                        className="rounded border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
                      >
                        {loadingReportId === row.session_id ? "Loading..." : "View Report"}
                      </button>
                    </td>
                    <td>
                      {["active", "pending"].includes((row.session_status || "").toLowerCase()) ? (
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => openWarningModal(row)}
                            className="flex items-center gap-1 rounded border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50"
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Warn
                          </button>
                          <button
                            onClick={() => openTerminateModal(row)}
                            className="flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
                          >
                            <ShieldAlert className="h-3.5 w-3.5" />
                            Terminate
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filteredSessionResults.length === 0 && <tr><td colSpan={11} className="py-3 text-slate-600">No session results for selected scope.</td></tr>}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
        </>
        )}

        {tab === "profile" && (
        <div className="scroll-mt-24">
        <DashboardPanel title="Profile Details">
          <div className="grid gap-3 md:grid-cols-2">
            <input value={me?.full_name || ""} readOnly className="rounded-md border border-border bg-muted/40 p-2 text-sm text-foreground" placeholder="Full name" />
            <input value={me?.registration_number || ""} readOnly className="rounded-md border border-border bg-muted/40 p-2 text-sm text-foreground" placeholder="Registration number" />
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone number" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <select value={department} onChange={e => setDepartment(e.target.value)} className="rounded-md border border-border bg-background p-2 text-sm text-foreground md:col-span-2">
              <option value="">Select Department</option>
              {LECTURER_DEPARTMENT_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
          {profileMsg ? <p className="mt-2 text-sm text-muted-foreground">{profileMsg}</p> : null}
          <button onClick={() => void updateProfile(false)} className="mt-3 rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#142145]">Save Profile</button>
        </DashboardPanel>
        <DashboardPanel title="Change Password">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-blue-700" />
            <h2 className="text-base font-semibold">Reset Password</h2>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="relative">
              <input
                type={showCurrentPassword ? "text" : "password"}
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                className="w-full rounded-md border border-border bg-background p-2 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
              <button type="button" onClick={() => setShowCurrentPassword(v => !v)} className="absolute inset-y-0 right-0 px-3 text-muted-foreground" aria-label={showCurrentPassword ? "Hide password" : "Show password"}>
                {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="relative">
              <input
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="New password"
                className="w-full rounded-md border border-border bg-background p-2 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
              <button type="button" onClick={() => setShowNewPassword(v => !v)} className="absolute inset-y-0 right-0 px-3 text-muted-foreground" aria-label={showNewPassword ? "Hide password" : "Show password"}>
                {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {passwordMsg && <p className="mt-2 text-sm text-slate-700">{passwordMsg}</p>}
          <button onClick={changePassword} disabled={savingPassword} className="mt-3 rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#142145] disabled:opacity-60">
            {savingPassword ? "Updating..." : "Update Password"}
          </button>
        </DashboardPanel>
        </div>
        )}
      </>
      ) : null}
    </DashboardShell>
    {editingExam ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Edit Exam</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Update the exam details shown to students.
              </p>
            </div>
            <button
              type="button"
              onClick={closeExamEditModal}
              className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Close edit exam modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form
            className="mt-5 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void saveExamEdit()
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Exam title
              <input
                value={editTitle}
                onChange={e => setEditTitle(e.target.value)}
                className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
                placeholder="Exam title"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium text-foreground">
              Course code
              <input
                value={editCourseCode}
                onChange={e => setEditCourseCode(e.target.value)}
                className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
                placeholder="Course code"
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Duration minutes
                <input
                  value={editDuration}
                  onChange={e => setEditDuration(e.target.value)}
                  className="rounded-md border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
                  placeholder="Duration minutes"
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-foreground">
                Schedule
                <input
                  type="datetime-local"
                  value={editSchedule}
                  onChange={e => setEditSchedule(e.target.value)}
                  onClick={(e) => {
                    const el = e.currentTarget as HTMLInputElement & { showPicker?: () => void }
                    el.showPicker?.()
                  }}
                  className="cursor-pointer rounded-md border border-border bg-background p-2 text-sm text-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              </label>
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Degree programs eligible for this exam <span className="text-red-600">*</span></p>
              <div className="mt-2 grid max-h-40 gap-1.5 overflow-y-auto rounded-md border border-border p-2 md:grid-cols-2">
                {programOptions.map((program) => (
                  <label key={program.program_id} className="flex items-start gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={editProgramIds.includes(program.program_id)}
                      onChange={() => setEditProgramIds((prev) => toggleProgramId(prev, program.program_id))}
                      className="mt-0.5"
                    />
                    {program.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={closeExamEditModal}
                disabled={savingExamEdit}
                className="rounded-md border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-accent disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingExamEdit}
                className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#142145] disabled:opacity-60"
              >
                {savingExamEdit ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      </div>
    ) : null}
    {viewingReport ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Session Report</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {viewingReport.student.full_name} ({viewingReport.student.reg_number}) &middot; {viewingReport.exam.title} ({viewingReport.exam.course_code})
              </p>
            </div>
            <button
              type="button"
              onClick={() => setViewingReport(null)}
              className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Close report"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <StatusBadge value={viewingReport.risk_level} />
            <span className="text-xs text-muted-foreground">{viewingReport.total_anomalies} total anomalies logged</span>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-md border border-border bg-background p-3 text-center">
              <p className="text-xl font-semibold text-foreground">
                {viewingReport.score != null ? `${viewingReport.score}/${viewingReport.total_marks}` : "-"}
              </p>
              <p className="text-xs text-muted-foreground">Score</p>
            </div>
            <div className="rounded-md border border-border bg-background p-3 text-center">
              <p className="text-xl font-semibold text-foreground">{viewingReport.warning_count ?? 0}</p>
              <p className="text-xs text-muted-foreground">Warnings</p>
            </div>
            <div className="rounded-md border border-border bg-background p-3 text-center">
              <StatusBadge value={viewingReport.session_status || "-"} />
              <p className="mt-1 text-xs text-muted-foreground">Status</p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[
              { label: "Gaze Away", value: viewingReport.gaze_away_count },
              { label: "Head Turned", value: viewingReport.head_turned_count },
              { label: "Tab Switch", value: viewingReport.tab_switch_count },
              { label: "Face Absent", value: viewingReport.face_absent_count },
              { label: "Multiple Faces", value: viewingReport.multiple_faces_count },
              { label: "Identity Mismatch", value: viewingReport.identity_mismatch_count },
            ].map((stat) => (
              <div key={stat.label} className="rounded-md border border-border bg-background p-3 text-center">
                <p className="text-xl font-semibold text-foreground">{stat.value}</p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</p>
              </div>
            ))}
          </div>

          <p className="mt-5 text-sm font-semibold text-foreground">Monitoring Timeline</p>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/60">
                <tr className="border-b text-left">
                  <th className="py-2 pl-2">Time</th>
                  <th>Event</th>
                  <th>Detail</th>
                  <th>Decision</th>
                  <th className="pr-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {viewingReport.logs.map((log) => {
                  const reportSessionStatus = (viewingReport.session_status || "").toLowerCase()
                  const canTerminate = ["active", "pending"].includes(reportSessionStatus)
                  const reportSessionRow: SessionResultRow = {
                    session_id: viewingReport.session_id,
                    exam_id: viewingReport.exam.exam_id,
                    student_name: viewingReport.student.full_name,
                    registration_number: viewingReport.student.reg_number,
                    student_email: viewingReport.student.email,
                    exam_title: viewingReport.exam.title,
                    course_code: viewingReport.exam.course_code,
                    session_status: viewingReport.session_status || "active",
                    score: viewingReport.score ?? null,
                    total_marks: viewingReport.total_marks,
                    warning_count: viewingReport.warning_count ?? 0,
                    risk_level: viewingReport.risk_level,
                  }
                  return (
                  <tr key={log.log_id} className="border-b last:border-b-0">
                    <td className="py-1.5 pl-2 whitespace-nowrap text-muted-foreground">
                      {log.logged_at ? new Date(log.logged_at).toLocaleTimeString() : "—"}
                    </td>
                    <td className="whitespace-nowrap font-medium text-foreground">{formatEventLabel(log.event_type)}</td>
                    <td className="text-muted-foreground">{formatEventDetail(log)}</td>
                    <td>
                      {log.is_suspicious === null || log.is_suspicious === undefined ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => void reviewLog(log.log_id, true)}
                            disabled={reviewingLogId === log.log_id}
                            className="rounded border border-red-300 px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                          >
                            Suspicious
                          </button>
                          <button
                            onClick={() => void reviewLog(log.log_id, false)}
                            disabled={reviewingLogId === log.log_id}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-60"
                          >
                            Dismiss
                          </button>
                        </div>
                      ) : (
                        <span className={cn("text-[11px] font-medium", log.is_suspicious ? "text-red-600" : "text-muted-foreground")}>
                          {log.is_suspicious ? "Suspicious" : "Dismissed"}
                        </span>
                      )}
                    </td>
                    <td className="pr-2">
                      {canTerminate ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => openWarningModal(reportSessionRow)}
                            className="flex items-center gap-1 whitespace-nowrap rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-50"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Warn
                          </button>
                          <button
                            onClick={() => openTerminateModal(reportSessionRow, log.event_type)}
                            className="flex items-center gap-1 whitespace-nowrap rounded border border-red-300 px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
                          >
                            <ShieldAlert className="h-3 w-3" />
                            Terminate
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                  )
                })}
                {viewingReport.logs.length === 0 && (
                  <tr><td colSpan={5} className="py-3 text-center text-muted-foreground">No anomalies were logged during this session.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    ) : null}
    {terminatingSession ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Terminate Exam Session</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {terminatingSession.student_name} ({terminatingSession.registration_number}) &middot; {terminatingSession.exam_title}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTerminatingSession(null)}
              disabled={terminating}
              className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Close terminate modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            This immediately ends the student&apos;s exam session. They will see the message below and will not be able to continue.
          </p>
          <label className="mt-4 grid gap-1.5 text-sm font-medium text-foreground">
            Message shown to student
            <textarea
              value={terminationReason}
              onChange={(e) => setTerminationReason(e.target.value)}
              rows={3}
              className="rounded-md border border-border bg-background p-2 text-sm text-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
          {terminateError ? <p className="mt-2 text-sm text-red-600">{terminateError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setTerminatingSession(null)}
              disabled={terminating}
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-accent disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmTerminateSession()}
              disabled={terminating || !terminationReason.trim()}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-60"
            >
              {terminating ? "Terminating..." : "Terminate Session"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    {warningTargetSession ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground">Send Warning</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {warningTargetSession.student_name} ({warningTargetSession.registration_number}) &middot; {warningTargetSession.exam_title}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setWarningTargetSession(null)}
              disabled={sendingWarning}
              className="rounded-md border border-border p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="Close warning modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            This sends the message below to the student in real time and adds it to their warning count. Their exam session continues uninterrupted.
          </p>
          <label className="mt-4 grid gap-1.5 text-sm font-medium text-foreground">
            Message shown to student
            <textarea
              value={warningMessage}
              onChange={(e) => setWarningMessage(e.target.value)}
              rows={3}
              className="rounded-md border border-border bg-background p-2 text-sm text-foreground focus:border-[#1a2d5a] focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
          {warningSendError ? <p className="mt-2 text-sm text-red-600">{warningSendError}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setWarningTargetSession(null)}
              disabled={sendingWarning}
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-accent disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmSendWarning()}
              disabled={sendingWarning || !warningMessage.trim()}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
            >
              {sendingWarning ? "Sending..." : "Send Warning"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    {showOnboarding ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <h3 className="text-lg font-semibold text-foreground">Complete Lecturer Onboarding</h3>
          <p className="mt-1 text-sm text-muted-foreground">Confirm your profile details before managing exams.</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <input value={me?.full_name || ""} readOnly className="rounded-md border border-border bg-muted/40 p-2 text-sm text-foreground" placeholder="Full name" />
            <input value={me?.registration_number || ""} readOnly className="rounded-md border border-border bg-muted/40 p-2 text-sm text-foreground" placeholder="Registration number" />
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone number" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <select value={department} onChange={e => setDepartment(e.target.value)} className="rounded-md border border-border bg-background p-2 text-sm text-foreground md:col-span-2">
              <option value="">Select Department</option>
              {LECTURER_DEPARTMENT_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
          {onboardingMsg ? <p className="mt-3 text-sm text-red-600">{onboardingMsg}</p> : null}
          <div className="mt-4 flex justify-end">
            <button onClick={() => void submitOnboarding()} disabled={onboardingSaving} className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {onboardingSaving ? "Saving..." : "Save & Continue"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    {showForcePasswordModal ? (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <h3 className="text-lg font-semibold text-foreground">Password Update Required</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You signed in with a temporary password. Set a new password to continue.
          </p>
          <div className="mt-4 grid gap-3">
            <input type={showCurrentPassword ? "text" : "password"} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Current temporary password" className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <input type={showNewPassword ? "text" : "password"} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="New password" className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground" />
          </div>
          {forcePasswordMsg ? <p className="mt-3 text-sm text-red-600">{forcePasswordMsg}</p> : null}
          <div className="mt-4 flex justify-end">
            <button onClick={() => void changePassword()} disabled={savingPassword} className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {savingPassword ? "Updating..." : "Update Password"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
  </>
  )
}

export default function LecturerDashboard() {
  return (
    <Suspense
      fallback={
        <DashboardShell
          appName="ProctorAI Lecturer"
          title="Lecturer Dashboard"
          subtitle=""
          sidebarItems={[]}
        >
          <DashboardPanel title="Loading Lecturer Dashboard">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Preparing your dashboard...
            </div>
          </DashboardPanel>
        </DashboardShell>
      }
    >
      <LecturerDashboardInner />
    </Suspense>
  )
}
