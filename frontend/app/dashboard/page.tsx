"use client"

import Link from "next/link"
import { Suspense } from "react"
import { useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { BookOpenCheck, ClipboardList, Eye, EyeOff, LogOut, UserCircle2 } from "lucide-react"
import { getApiPath } from "@/lib/api-url"
import { DashboardPanel, DashboardShell, MetricCard } from "@/components/dashboard-shell"
import { StatusBadge } from "@/components/status-badge"

type StudentTab = "dashboard" | "exams" | "sessions" | "profile"

const STUDENT_TAB_TITLES: Record<StudentTab, string> = {
  dashboard: "Dashboard",
  exams: "Exams",
  sessions: "Sessions & Reports",
  profile: "Profile",
}

type MeUser = {
  user_id: number
  full_name: string
  registration_number: string
  email: string
  phone_number?: string | null
  department?: string | null
  academic_year?: string | null
  year_enrolled?: number | null
  student_profile_confirmed?: boolean
  role: string
  must_change_password: boolean
}

type ExamRow = {
  exam_id: number
  title: string
  course_code: string
  duration_min: number
  scheduled_at?: string | null
  status: string
  lecturer_name?: string | null
}

type MyReportRow = {
  session_id: number
  exam_id?: number
  exam_title: string
  course_code: string
  score?: number | null
  total_marks: number
  warning_count: number
  risk_level: string
  total_anomalies: number
  gaze_away_count: number
  head_turned_count: number
  tab_switch_count: number
  face_absent_count: number
  multiple_faces_count: number
  identity_mismatch_count: number
  session_status: string
}

const ANOMALY_TYPE_LABELS: { key: keyof MyReportRow; label: string }[] = [
  { key: "gaze_away_count", label: "Gaze" },
  { key: "head_turned_count", label: "Head Turn" },
  { key: "face_absent_count", label: "Face Missing" },
  { key: "multiple_faces_count", label: "Multiple Faces" },
  { key: "tab_switch_count", label: "Tab Switch" },
  { key: "identity_mismatch_count", label: "Identity Mismatch" },
]

function formatAnomalyBreakdown(row: MyReportRow): string {
  const parts = ANOMALY_TYPE_LABELS
    .map(({ key, label }) => ({ label, count: row[key] as number }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.label} ×${entry.count}`)
  return parts.length > 0 ? parts.join(", ") : "None"
}

const FALLBACK_DEGREE_PROGRAM_OPTIONS = [
  "Bachelor of Science in Information Technology with Business Analytics",
  "Bachelor of Science in Instructional Design and Information Technology (BSc IDIT)",
  "Bachelor of Science in Multimedia Technology and Animation",
  "Bachelor of Science in Computer Networks and Information Security Engineering (BSc CNISE)",
  "Bachelor of Science in Computer Engineering (BSc CE)",
  "Bachelor of Science in Computer Science (BSc CS)",
  "Bachelor of Science in Software Engineering (BSc SE)",
  "Bachelor of Science in Cyber Security and Digital Forensics Engineering (BSc CSDFE)",
  "Bachelor of Science in Business Information Systems (BSc BIS)",
  "Bachelor of Science in Multimedia Technology and Animation (BSc MTA)",
  "Bachelor of Science in Telecommunication Engineering (BSc TE)",
  "Bachelor of Science in Digital Content and Broadcasting Engineering (BSc DCBE)",
  "Bachelor of Science in Information Systems (BSc IS)",
  "Diploma in Cyber Security and Digital Forensics (Dip. CSDF)",
  "Diploma in Educational Technology (Dip. ET)",
  "Diploma in Information and Communication Technology (Dip. ICT)",
]

function formatDateTime(value?: string | null) {
  if (!value) return "TBD"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "TBD"
  return date.toLocaleString()
}

function StudentDashboardInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tab = ((searchParams.get("tab") as StudentTab) || "dashboard")
  const [token, setToken] = useState("")
  const [me, setMe] = useState<MeUser | null>(null)
  const [exams, setExams] = useState<ExamRow[]>([])
  const [reports, setReports] = useState<MyReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [profileMsg, setProfileMsg] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [department, setDepartment] = useState("")
  const [academicYear, setAcademicYear] = useState("")
  const [yearEnrolled, setYearEnrolled] = useState("")
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [passwordMsg, setPasswordMsg] = useState("")
  const [isExiting, setIsExiting] = useState(false)
  const [baselineImageUrl, setBaselineImageUrl] = useState<string | null>(null)
  const [baselineLoadError, setBaselineLoadError] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingSaving, setOnboardingSaving] = useState(false)
  const [onboardingMsg, setOnboardingMsg] = useState("")
  const [showForcePasswordModal, setShowForcePasswordModal] = useState(false)
  const [forcePasswordMsg, setForcePasswordMsg] = useState("")
  const [degreeProgramOptions, setDegreeProgramOptions] = useState<string[]>(FALLBACK_DEGREE_PROGRAM_OPTIONS)

  useEffect(() => {
    const rawToken = localStorage.getItem("token")
    if (!rawToken) {
      router.push("/")
      return
    }
    document.cookie = `auth_token=${rawToken}; Path=/; Max-Age=${60 * 60 * 8}; SameSite=Lax`
    setToken(rawToken)
    void load(rawToken)
  }, [router])

  useEffect(() => {
    return () => {
      if (baselineImageUrl) URL.revokeObjectURL(baselineImageUrl)
    }
  }, [baselineImageUrl])

  async function load(activeToken: string) {
    setLoading(true)
    setError("")
    try {
      const [meRes, examsRes, reportsRes, programsRes] = await Promise.all([
        fetch(getApiPath("/auth/me"), { headers: { Authorization: `Bearer ${activeToken}` } }),
        fetch(getApiPath("/exams"), { headers: { Authorization: `Bearer ${activeToken}` } }),
        fetch(getApiPath("/reports/my"), { headers: { Authorization: `Bearer ${activeToken}` } }),
        fetch(getApiPath("/exams/programs"), { headers: { Authorization: `Bearer ${activeToken}` } }),
      ])
      const mePayload = await meRes.json().catch(() => ({}))
      const examsPayload = await examsRes.json().catch(() => ({}))
      const reportsPayload = await reportsRes.json().catch(() => ({}))
      const programsPayload = await programsRes.json().catch(() => ({}))
      if (programsRes.ok && Array.isArray(programsPayload.programs) && programsPayload.programs.length > 0) {
        setDegreeProgramOptions(programsPayload.programs.map((p: { name: string }) => p.name))
      }

      if (!meRes.ok) {
        localStorage.removeItem("token")
        localStorage.removeItem("user")
        router.push("/")
        return
      }
      if (mePayload?.user?.role === "administrator" || mePayload?.user?.role === "admin") {
        router.push("/admin")
        return
      }
      if (mePayload?.user?.role === "lecturer") {
        router.push("/lecturer")
        return
      }

      setMe(mePayload.user)
      setShowForcePasswordModal(Boolean(mePayload.user?.must_change_password))
      setEmail(mePayload.user?.email || "")
      setPhone(mePayload.user?.phone_number || "")
      setDepartment(mePayload.user?.department || "")
      setAcademicYear(mePayload.user?.academic_year || "")
      setYearEnrolled(mePayload.user?.year_enrolled ? String(mePayload.user.year_enrolled) : "")
      setExams(examsPayload.exams || [])
      setReports(reportsPayload.reports || [])
      const hasBaseline = await loadBaselineImage(activeToken)
      const needsOnboarding =
        !Boolean(mePayload.user?.student_profile_confirmed) ||
        !String(mePayload.user?.full_name || "").trim() ||
        !String(mePayload.user?.registration_number || "").trim() ||
        !String(mePayload.user?.department || "").trim() ||
        !String(mePayload.user?.academic_year || "").trim() ||
        !Number.isFinite(Number(mePayload.user?.year_enrolled)) ||
        !hasBaseline
      setShowOnboarding(Boolean(needsOnboarding))
    } finally {
      setLoading(false)
    }
  }

  async function loadBaselineImage(activeToken = token) {
    try {
      const res = await fetch(`${getApiPath("/images/me")}?t=${Date.now()}`, {
        headers: { Authorization: `Bearer ${activeToken}` },
        cache: "no-store",
      })
      if (!res.ok) {
        setBaselineImageUrl(null)
        setBaselineLoadError(res.status === 404 ? null : "Could not load baseline image preview.")
        return false
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      setBaselineImageUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return objectUrl
      })
      setBaselineLoadError(null)
      return true
    } catch {
      setBaselineImageUrl(null)
      setBaselineLoadError("Could not load baseline image preview.")
      return false
    }
  }

  async function startExam(examId: number) {
    if (showOnboarding) {
      setError("Complete onboarding details and upload baseline photo before starting exams.")
      return
    }
    setError("")
    const res = await fetch(getApiPath("/sessions/start"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ exam_id: examId }),
    })
    const payload = await res.json().catch(() => ({}))
    const sessionId = Number(payload?.session_id)
    if (res.status === 201 && Number.isFinite(sessionId) && sessionId > 0) {
      localStorage.setItem("session_id", String(payload.session_id))
      localStorage.setItem("exam_id", String(examId))
      router.push("/verify")
      return
    }
    if (res.status === 409) {
      const backendMessage = String(payload?.error?.message || "").toLowerCase()
      localStorage.removeItem("session_id")
      localStorage.removeItem("exam_id")
      if (backendMessage.includes("already has an active exam session")) {
        setError("No active exam session found. Previous attempts are auto-submitted and cannot be resumed. Start a new assigned exam.")
        await load(token)
        return
      }
      await load(token)
    }
    setError(payload?.error?.message || "Could not start exam.")
  }

  async function updateProfile() {
    setProfileMsg("")
    const res = await fetch(getApiPath("/users/profile"), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        email,
        phone_number: phone,
        department,
        academic_year: academicYear,
        year_enrolled: yearEnrolled ? Number(yearEnrolled) : undefined,
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) {
      setProfileMsg(payload?.error?.message || "Could not update profile.")
      return
    }
    setProfileMsg("Profile updated successfully.")
    if (payload?.user) {
      setMe(payload.user)
      localStorage.setItem("user", JSON.stringify(payload.user))
    }
  }

  async function uploadBaselineImage(file: File | null) {
    if (!file) return
    setUploadingImage(true)
    setUploadProgress(0)
    setProfileMsg("")
    try {
      const body = new FormData()
      body.append("image", file)

      const result = await new Promise<{ ok: boolean; payload: any }>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open("POST", getApiPath("/images/me"))
        xhr.setRequestHeader("Authorization", `Bearer ${token}`)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () => {
          let payload: any = {}
          try {
            payload = JSON.parse(xhr.responseText)
          } catch {
            payload = {}
          }
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, payload })
        }
        xhr.onerror = () => reject(new Error("Network error during upload"))
        xhr.send(body)
      })

      if (!result.ok) {
        setProfileMsg(result.payload?.error?.message || "Could not upload image.")
        return
      }
      setUploadProgress(100)
      setProfileMsg("Baseline face image uploaded successfully.")
      await loadBaselineImage(token)
    } catch {
      setProfileMsg("Could not upload image.")
    } finally {
      setUploadingImage(false)
      setTimeout(() => setUploadProgress(null), 1000)
    }
  }

  async function changePassword() {
    setPasswordMsg("")
    setForcePasswordMsg("")
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
  }

  async function submitOnboarding() {
    setOnboardingMsg("")
    const currentName = String(me?.full_name || "").trim()
    const currentReg = String(me?.registration_number || "").trim()

    if (!currentName) return setOnboardingMsg("Full name is required.")
    if (!currentReg) return setOnboardingMsg("Registration number is required.")
    if (!department.trim()) return setOnboardingMsg("Degree program is required.")
    if (!academicYear.trim()) return setOnboardingMsg("Current academic year is required.")
    if (!yearEnrolled.trim() || !Number.isFinite(Number(yearEnrolled))) return setOnboardingMsg("Year enrolled must be a valid year.")
    if (!baselineImageUrl) return setOnboardingMsg("Baseline photo is required.")

    setOnboardingSaving(true)
    try {
      const res = await fetch(getApiPath("/users/profile"), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          full_name: currentName,
          registration_number: currentReg,
          email,
          phone_number: phone,
          department,
          academic_year: academicYear,
          year_enrolled: Number(yearEnrolled),
          confirm_profile: true,
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        setOnboardingMsg(payload?.error?.message || "Could not save onboarding details.")
        return
      }
      if (payload?.user) {
        setMe(payload.user)
        localStorage.setItem("user", JSON.stringify(payload.user))
      }
      setOnboardingMsg("Profile confirmed successfully.")
      setShowOnboarding(false)
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

  const completed = useMemo(() => reports.filter(r => r.session_status === "completed").length, [reports])
  const studentProfileLocked = useMemo(
    () =>
      Boolean(
        !showOnboarding &&
          String(me?.department || "").trim() &&
          String(me?.academic_year || "").trim() &&
          Number.isFinite(Number(me?.year_enrolled)),
      ),
    [me, showOnboarding],
  )
  const sessionByExamId = useMemo(() => {
    const map = new Map<number, MyReportRow>()
    for (const session of reports) {
      if (typeof session.exam_id === "number") map.set(session.exam_id, session)
    }
    return map
  }, [reports])

  return (
    <>
    <DashboardShell
      appName="ProctorAI Student"
      title={STUDENT_TAB_TITLES[tab] || "Dashboard"}
      subtitle={`${me?.full_name || "-"} | ${me?.registration_number || "-"} | ${me?.department || "Course not set"}`}
      sidebarItems={[
        { label: "Dashboard", href: "/dashboard", active: tab === "dashboard" },
        { label: "Exams", href: "/dashboard?tab=exams", active: tab === "exams" },
        { label: "Sessions & Reports", href: "/dashboard?tab=sessions", active: tab === "sessions" },
        { label: "Profile", href: "/dashboard?tab=profile", active: tab === "profile" },
      ]}
      avatarName={me?.full_name}
      avatarImageUrl={baselineImageUrl}
      rightTopSlot={
        <button onClick={() => void logout()} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground">
          <LogOut className="h-4 w-4" /> Logout
        </button>
      }
      isExiting={isExiting}
      exitMessage="Signing out of student account..."
    >
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {loading ? (
        <DashboardPanel title="Loading Student Dashboard">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            Preparing your data...
          </div>
        </DashboardPanel>
      ) : null}

      {!loading ? (
      <>
      {tab === "dashboard" ? (
        <>
          <section className="grid gap-3 md:grid-cols-3">
            <MetricCard label="Available Exams" value={exams.length} />
            <MetricCard label="Completed Sessions" value={completed} />
            <MetricCard label="Total Sessions" value={reports.length} />
          </section>
          <DashboardPanel title="Quick Shortcuts" subtitle="Move quickly between core student tasks.">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Link href="/dashboard?tab=exams" className="rounded-xl border border-border bg-gradient-to-br from-blue-50 to-indigo-50 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
                <BookOpenCheck className="h-5 w-5 text-[#1a2d5a]" />
                <p className="mt-2 text-sm font-semibold text-foreground">Exams</p>
                <p className="mt-1 text-xs text-muted-foreground">Start your assigned exams.</p>
              </Link>
              <Link href="/dashboard?tab=sessions" className="rounded-xl border border-border bg-gradient-to-br from-emerald-50 to-teal-50 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
                <ClipboardList className="h-5 w-5 text-emerald-700" />
                <p className="mt-2 text-sm font-semibold text-foreground">Sessions &amp; Reports</p>
                <p className="mt-1 text-xs text-muted-foreground">Track score, status, and risk level.</p>
              </Link>
              <Link href="/dashboard?tab=profile" className="rounded-xl border border-border bg-gradient-to-br from-violet-50 to-fuchsia-50 p-4 transition hover:shadow-md dark:from-slate-900 dark:to-slate-800">
                <UserCircle2 className="h-5 w-5 text-violet-700" />
                <p className="mt-2 text-sm font-semibold text-foreground">Profile</p>
                <p className="mt-1 text-xs text-muted-foreground">Update required verification info.</p>
              </Link>
            </div>
          </DashboardPanel>
        </>
      ) : null}

      {tab === "exams" ? (
        <DashboardPanel title="Assigned Exams">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left">
                  <th className="py-2 pl-3">Title</th>
                  <th>Course</th>
                  <th>Lecturer</th>
                  <th>Schedule</th>
                  <th>Status</th>
                  <th className="pr-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {exams.map((exam) => (
                  <tr key={exam.exam_id} className="border-b last:border-b-0">
                    <td className="py-2 pl-3 font-medium">{exam.title}</td>
                    <td>{exam.course_code}</td>
                    <td>{exam.lecturer_name || "-"}</td>
                    <td>{formatDateTime(exam.scheduled_at)}</td>
                    <td><StatusBadge value={exam.status} /></td>
                    <td className="pr-3">
                      {(() => {
                        const session = sessionByExamId.get(exam.exam_id)
                        // A session is single-attempt only (student_id+exam_id is
                        // unique server-side) - once it's reached a terminal state,
                        // POST /sessions/start will just 409 "cannot be resumed", so
                        // the button must stop inviting another click rather than
                        // surface that as a confusing error after the fact.
                        const isTerminal = session
                          ? session.session_status === "completed" ||
                            session.session_status === "terminated" ||
                            session.session_status === "locked"
                          : false
                        const started = Boolean(session && !isTerminal)
                        if (isTerminal) {
                          return (
                            <button
                              disabled
                              className="cursor-not-allowed rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground"
                            >
                              {session?.session_status === "terminated" ? "Terminated" : "Submitted"}
                            </button>
                          )
                        }
                        return (
                      <button onClick={() => void startExam(exam.exam_id)} className="rounded-md bg-[#1a2d5a] px-3 py-1.5 text-xs font-semibold text-white">
                        {started ? "Start New Attempt" : "Start Exam"}
                      </button>
                        )
                      })()}
                    </td>
                  </tr>
                ))}
                {exams.length === 0 ? <tr><td colSpan={6} className="py-3 pl-3 text-muted-foreground">No exams assigned.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
      ) : null}

      {tab === "sessions" ? (
        <DashboardPanel title="Sessions & Reports" subtitle="Warnings is the total flagged count (including any lecturer-sent warning); Anomalies breaks down what was actually detected.">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left">
                  <th className="py-2 pl-3">Exam</th>
                  <th>Course</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Warnings</th>
                  <th>Risk</th>
                  <th>Anomalies</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.session_id} className="border-b last:border-b-0">
                    <td className="py-2 pl-3">{r.exam_title}</td>
                    <td>{r.course_code}</td>
                    <td><StatusBadge value={r.session_status} /></td>
                    <td>{r.score != null ? `${r.score}/${r.total_marks}` : "-"}</td>
                    <td>{r.warning_count}</td>
                    <td><StatusBadge value={r.risk_level} /></td>
                    <td className="max-w-[220px] text-xs text-muted-foreground">{formatAnomalyBreakdown(r)}</td>
                  </tr>
                ))}
                {reports.length === 0 ? <tr><td colSpan={7} className="py-3 pl-3 text-muted-foreground">No sessions yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </DashboardPanel>
      ) : null}

      {tab === "profile" ? (
        <>
          <DashboardPanel title="Profile">
            <div className="grid gap-3 md:grid-cols-2">
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone number" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
              <select value={department} onChange={e => setDepartment(e.target.value)} disabled={studentProfileLocked} className="rounded-md border border-border bg-background p-2 text-sm text-foreground disabled:cursor-not-allowed disabled:bg-muted/40 md:col-span-2">
                <option value="">Select Degree / Course Program</option>
                {degreeProgramOptions.map((program) => (
                  <option key={program} value={program}>{program}</option>
                ))}
              </select>
              <input value={academicYear} onChange={e => setAcademicYear(e.target.value)} placeholder="Current academic year (e.g. Year 2)" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
              <input value={yearEnrolled} onChange={e => setYearEnrolled(e.target.value)} disabled={studentProfileLocked} placeholder="Year enrolled (e.g. 2024)" className="rounded-md border border-border bg-background p-2 text-sm text-foreground disabled:cursor-not-allowed disabled:bg-muted/40" />
            </div>
            {studentProfileLocked ? <p className="mt-2 text-xs text-muted-foreground">Only email, phone, and current academic year can be updated here. Degree program and year enrolled require admin change.</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => void updateProfile()} className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white">Save Profile</button>
            </div>
            {profileMsg ? <p className="mt-2 text-sm text-muted-foreground">{profileMsg}</p> : null}
          </DashboardPanel>
          <DashboardPanel title="Baseline Image" subtitle="This image is used for identity verification before exams.">
            <div className="flex flex-wrap items-center gap-4">
              <div className="h-24 w-24 overflow-hidden rounded-xl border border-border bg-muted/40">
                {baselineImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={baselineImageUrl} alt="Baseline preview" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">No image</div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Status: <span className="font-medium text-foreground">{baselineImageUrl ? "Uploaded" : "Not uploaded"}</span>
                </p>
                {baselineLoadError ? <p className="text-xs text-red-500">{baselineLoadError}</p> : null}
                <label className="w-fit cursor-pointer rounded-md border px-3 py-1.5 text-sm font-semibold">
                  {uploadingImage ? "Uploading..." : baselineImageUrl ? "Replace Image" : "Upload Image"}
                  <input type="file" accept="image/jpeg,image/png" className="hidden" onChange={(e) => void uploadBaselineImage(e.target.files?.[0] ?? null)} />
                </label>
                {uploadProgress !== null ? (
                  <div className="w-48">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-[#1a2d5a] transition-all duration-150"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{uploadProgress}%</p>
                  </div>
                ) : null}
              </div>
            </div>
          </DashboardPanel>
          <DashboardPanel title="Reset Password">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="relative">
                <input type={showCurrentPassword ? "text" : "password"} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Current password" className="w-full rounded-md border border-border bg-background p-2 pr-10 text-sm text-foreground" />
                <button type="button" onClick={() => setShowCurrentPassword(v => !v)} className="absolute inset-y-0 right-0 px-3 text-muted-foreground" aria-label={showCurrentPassword ? "Hide password" : "Show password"}>
                  {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="relative">
                <input type={showNewPassword ? "text" : "password"} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="New password" className="w-full rounded-md border border-border bg-background p-2 pr-10 text-sm text-foreground" />
                <button type="button" onClick={() => setShowNewPassword(v => !v)} className="absolute inset-y-0 right-0 px-3 text-muted-foreground" aria-label={showNewPassword ? "Hide password" : "Show password"}>
                  {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {passwordMsg ? <p className="mt-2 text-sm text-muted-foreground">{passwordMsg}</p> : null}
            <button onClick={() => void changePassword()} className="mt-3 rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white">Update Password</button>
          </DashboardPanel>
        </>
      ) : null}
      </>
      ) : null}
    </DashboardShell>
    {showOnboarding ? (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
        <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-5 shadow-2xl">
          <h3 className="text-lg font-semibold text-foreground">Complete Student Onboarding</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your registered details before continuing.
          </p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <input value={me?.full_name || ""} readOnly className="rounded-md border border-border bg-muted/40 p-2 text-sm text-foreground" placeholder="Full name" />
            <input value={me?.registration_number || ""} readOnly className="rounded-md border border-border bg-muted/40 p-2 text-sm text-foreground" placeholder="Registration number" />
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone number" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <select value={department} onChange={e => setDepartment(e.target.value)} className="rounded-md border border-border bg-background p-2 text-sm text-foreground">
              <option value="">Select Degree Program</option>
              {degreeProgramOptions.map((program) => (
                <option key={program} value={program}>{program}</option>
              ))}
            </select>
            <input value={academicYear} onChange={e => setAcademicYear(e.target.value)} placeholder="Current academic year (e.g. Year 2)" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <input value={yearEnrolled} onChange={e => setYearEnrolled(e.target.value)} placeholder="Year enrolled (e.g. 2024)" className="rounded-md border border-border bg-background p-2 text-sm text-foreground" />
            <div className="md:col-span-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground">
                {uploadingImage ? "Uploading..." : "Upload Baseline Photo"}
                <input type="file" accept="image/jpeg,image/png" className="hidden" onChange={(e) => void uploadBaselineImage(e.target.files?.[0] ?? null)} />
              </label>
              {uploadProgress !== null ? (
                <div className="mt-2 w-48">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-[#1a2d5a] transition-all duration-150"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{uploadProgress}%</p>
                </div>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">
                Baseline status: {baselineImageUrl ? "Uploaded" : "Not uploaded"}
              </p>
            </div>
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
            <input type={showCurrentPassword ? "text" : "password"} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Current temporary password" className="w-full rounded-md border border-border bg-background p-2 pr-10 text-sm text-foreground" />
            <input type={showNewPassword ? "text" : "password"} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="New password" className="w-full rounded-md border border-border bg-background p-2 pr-10 text-sm text-foreground" />
          </div>
          {forcePasswordMsg ? <p className="mt-3 text-sm text-red-600">{forcePasswordMsg}</p> : null}
          <div className="mt-4 flex justify-end">
            <button onClick={() => void changePassword()} className="rounded-md bg-[#1a2d5a] px-4 py-2 text-sm font-semibold text-white">
              Update Password
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  )
}

export default function StudentDashboardPage() {
  return (
    <Suspense
      fallback={
        <DashboardShell
          appName="ProctorAI Student"
          title="Dashboard"
          subtitle=""
          sidebarItems={[]}
        >
          <DashboardPanel title="Loading Student Dashboard">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Preparing your data...
            </div>
          </DashboardPanel>
        </DashboardShell>
      }
    >
      <StudentDashboardInner />
    </Suspense>
  )
}
