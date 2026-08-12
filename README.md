# AI-Based Online Examination Proctoring System

> University of Dodoma · Final Year Project 2025/26 · Supervisor: Dr. Mohamed Dewa

An AI-powered platform for remote exam proctoring. It verifies a student's identity against a stored facial profile before an exam starts, continuously monitors behaviour during the exam using computer vision (gaze tracking, head pose, face presence/count, tab switching, and periodic re-identification), and gives lecturers and admins a live dashboard plus a post-exam behavioural report for every session — while leaving the exam itself in the student's hands: proctoring signals are logged for human review, never used to auto-submit or lock a session.

[![CI](https://github.com/victorjudysen/ai-exam-proctoring-system/actions/workflows/ci.yml/badge.svg)](https://github.com/victorjudysen/ai-exam-proctoring-system/actions/workflows/ci.yml)
[![CD](https://github.com/victorjudysen/ai-exam-proctoring-system/actions/workflows/cd.yml/badge.svg)](https://github.com/victorjudysen/ai-exam-proctoring-system/actions/workflows/cd.yml)

**Live:** [proctoai.neuraltale.com](https://proctoai.neuraltale.com) (frontend, Vercel) · [proctoaibackend.neuraltale.com](https://proctoaibackend.neuraltale.com) (backend + AI service, VPS)

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [How Proctoring Works](#how-proctoring-works)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
- [Running Tests](#running-tests)
- [CI/CD](#cicd)
- [Quality Targets](#quality-targets)
- [Security Notes](#security-notes)
- [Team](#team)
- [License](#license)

---

## Overview

Traditional online exams have no way to confirm that the person answering is who they claim to be, or that they aren't consulting outside help mid-exam. This system addresses that with a real-time computer vision pipeline layered on top of a conventional exam-delivery platform:

1. **Identity verification** — before an exam starts, the student's live webcam frame is matched against their registered facial profile (FaceNet embeddings + cosine similarity).
2. **Continuous behavioural monitoring** — while the exam is in progress, webcam frames are streamed over WebSocket and analysed for gaze direction, head pose, number of faces in frame, and periodic re-identification, to catch impersonation or someone stepping in mid-exam.
3. **Human-in-the-loop review** — every confirmed anomaly is logged against the session for the lecturer/admin to review afterward. Lecturers can also intervene live: send a real-time warning to a student, or terminate a session outright if warranted. Nothing is automated to the point of silently failing a student.

The result is a tool that gives academic staff visibility into exam integrity without taking the decision to fail or block a student out of human hands.

---

## Key Features

**For students**
- Face-registration during account setup, one-time identity check before entering an exam, and a guided camera/orientation calibration step
- Timed exam-taking UI with autosaved answers (survives a dropped connection or an abrupt session end)
- Live in-exam notification if a lecturer sends a manual warning; a clear termination screen if a session is ended

**For lecturers**
- Create, edit, and publish exams (MCQ / true-false / short-answer questions)
- Live dashboard of in-progress sessions with a real-time suspicious-activity feed
- Per-session behavioural report after the exam: anomaly counts by type, risk level, and timeline
- Manual controls: send a live warning to a student, or terminate a session mid-exam (with automatic scoring of whatever was answered so far)

**For admins**
- User management, credential provisioning/reset, and system-wide exam oversight
- Access to system logs and exam-wide reporting/export across all lecturers' sessions
- Full visibility into every session's identity-verification and anomaly history

---

## How Proctoring Works

| Signal | Detection method | Notes |
|---|---|---|
| **Identity mismatch** | MTCNN face detection → FaceNet (ONNX) embedding → cosine similarity vs. stored profile | Checked once before the exam starts, then periodically (every ~8s) throughout — requires 2 consecutive mismatches before it's confirmed, to avoid penalizing a single bad-angle frame |
| **Gaze away from screen** | Custom lightweight CNN (~101K params) trained on MPIIGaze, 5-class output (Screen/Up/Down/Left/Right) with proper Zhang et al. (2018) data normalization (3D head pose + virtual camera warp) | Requires the same direction sustained continuously for ~2s and a confidence threshold before it counts — flip-flopping between directions is treated as model noise, not a violation |
| **Head turned away** | MediaPipe Face Mesh + OpenCV `solvePnP` for 3D pose (yaw/pitch/roll) | ~2s sustained-persistence window, same as gaze |
| **No face / multiple faces** | Face detection on each frame | ~2s sustained-persistence window |
| **Tab switch** | Browser `visibilitychange` event | Logged immediately |

All of the above are **debounced and confidence-gated** before being counted, and none of them are tracked during the initial camera calibration step — only once the student is confirmed to actually be in the exam. Each confirmed anomaly increments the session's warning count and writes a timestamped entry to its behavioural log, visible to lecturers/admins in the live feed and the post-exam report.

**Nothing here submits, locks, or blocks the student automatically.** The exam always ends by manual submission or time-up. The only ways a session ends early are a lecturer explicitly terminating it (scoring whatever was answered so far) or the student's own submission.

---

## Architecture

```
                     ┌─────────────────────────┐
                     │   Browser (Student /     │
                     │   Lecturer / Admin)       │
                     │   Next.js 15 · React 19   │
                     └────────────┬──────────────┘
                                  │
              HTTP (axios)        │        WebSocket (socket.io)
                                  │
         ┌────────────────────────┴───────────────────────┐
         ▼                                                 ▼
┌─────────────────────┐                       ┌──────────────────────────┐
│  Backend API (Flask)  │◄──── internal ─────►│  AI Service (Flask +       │
│  Auth · Exams ·       │   token-authed HTTP   │  Socket.IO)                │
│  Sessions · Reports ·  │                       │  FaceNet (ONNX) — identity │
│  Users · Images        │                       │  Gaze CNN (ONNX)           │
│  :5000                 │                       │  MediaPipe — head pose     │
└──────────┬──────────────┘                     └────────────┬────────────┘
           │                                                    │
           ▼                                                    ▼
   ┌───────────────┐                                  ┌─────────────────────┐
   │  PostgreSQL     │                                  │  /storage/faces/       │
   │  7 tables        │                                  │  (server-only, never    │
   └───────────────┘                                  │  in git)                 │
                                                        └─────────────────────┘
```

The backend and AI service are two independent Python/Flask processes with their own responsibilities: the backend owns all persistent state (users, exams, sessions, reports) and business rules; the AI service owns model inference and the real-time frame pipeline, calling back into the backend over an internally authenticated HTTP endpoint whenever it needs session/user context it isn't trusted to take from the client directly.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind CSS, shadcn/ui, Recharts |
| Backend API | Python, Flask, Gunicorn, SQLAlchemy + Alembic, Flask-JWT-Extended |
| AI Service | Python, Flask, Flask-SocketIO, ONNX Runtime, MediaPipe, OpenCV |
| Database | PostgreSQL 15 |
| Auth | JWT (role-based: student / lecturer / admin) |
| Containerization | Docker, Docker Compose |
| CI/CD | GitHub Actions (backend + AI service to a VPS), Vercel (frontend) |

---

## Repository Structure

```
ai-exam-proctoring-system/
├── frontend/                    Next.js app — student/lecturer/admin UIs (Vercel)
├── backend/
│   └── app/                     Live Flask REST API: auth, users, exams, sessions, reports, images, search
├── ai-service/
│   ├── routes/                  Synchronous HTTP endpoints (health, one-time identity verify, monitor)
│   ├── sockets/                 Real-time per-frame pipeline (Socket.IO frame handler)
│   └── services/                Model loading & CV logic (face detection, gaze, head pose, identity)
├── docs/                        SRS, API spec, test cases
├── .github/workflows/           CI and CD pipelines
├── docker-compose.yml           Local dev stack (postgres, backend, ai-service, frontend)
└── docker-compose.api-prod.yml  Production compose used by CD on the VPS (backend + ai-service only)
```

> `backend/` also contains an earlier, unused Node/Express implementation (`server.js`, `routes/*.js`, Sequelize `models/`) and a root-level Jest suite (`tests/`) that only exercises it. None of it runs in any deployed environment — the live backend is entirely `backend/app/` (Flask). See `CLAUDE.md` for details if contributing.

---

## Getting Started

### Run everything with Docker

```bash
cp backend/.env.example backend/.env
cp ai-service/.env.example ai-service/.env
docker compose up
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:5000 |
| AI Service | http://localhost:8000 |

### Run services individually

**Frontend**
```bash
cd frontend
pnpm install
npm run dev          # http://localhost:3000
```

**Backend**
```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python run.py         # http://localhost:5000
```

**AI service**
```bash
cd ai-service
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py         # http://localhost:8000
```

> The AI service needs `facenet_best.onnx` and `gaze_model.onnx` in `ai-service/models/`. These are gitignored (not committed) — place them manually on any machine that needs to run inference.

---

## Running Tests

```bash
# Backend — real Flask app, in-memory SQLite, no setup required
cd backend && python -m pytest tests/ -v

# AI service
cd ai-service && python -m pytest tests/ -v

# Root-level Jest suite — exercises the legacy/unused Node backend only,
# not a signal on backend/app/ behaviour
npm install && npm test
```

There is no automated frontend test suite — UI changes are verified manually via `npm run dev`.

---

## CI/CD

- **CI** (`ci.yml`) runs on every push and PR to `main`: full test suite, then Docker image builds. The build step is gated on tests passing.
- **CD** (`cd.yml`) deploys the **backend and AI service only**, automatically after CI passes on `main` (or manually via `workflow_dispatch`). It SSHs into the VPS, pulls latest, validates required model files are present, rebuilds via `docker-compose.api-prod.yml`, runs Alembic migrations, and restarts services.
- **Frontend** deploys independently and automatically through Vercel's own GitHub integration on every push to `main` — it is not part of `cd.yml` and has no container on the VPS.

---

## Quality Targets

| Metric | Target |
|---|---|
| Facial recognition accuracy | ≥ 90% |
| False Acceptance Rate (FAR) | < 5% |
| False Rejection Rate (FRR) | < 10% |
| Identity verification latency | < 3 seconds |
| Frame processing time | < 1 sec/frame |
| System uptime during exams | ≥ 95% |
| Concurrent exam sessions | ≥ 100 |
| Gaze estimation MAE | < 5° |
| Head pose estimation MAE | < 5° |
| SUS usability score | ≥ 3.5 / 5.0 |

---

## Security Notes

- Facial images and model embeddings are stored server-side only (`/storage/faces/`) and never committed to git or exposed to non-admin roles.
- Passwords are bcrypt-hashed; JWTs carry role claims and every route is enforced server-side (the frontend's route guard is UX-only, not a trust boundary).
- Service-to-service calls from the AI service to the backend are authenticated with an internal token header, never a client-supplied user ID — this prevents an impostor from spoofing their way past identity verification by claiming someone else's account.
- `.env` files, model weights (`*.pt`, `*.onnx`), and facial images are all excluded via `.gitignore`.

---

## Team

| Name | Reg. No | Role |
|---|---|---|
| Victor J. Kweka | T22-03-11759 | Project Lead + AI Service |
| Julius P. Ntale | T22-03-05441 | Frontend Engineer |
| Derick G. Mhidze | T22-03-04321 | Backend Engineer |
| Beckham Y. Mwakanjuki | T22-03-10715 | AI/ML Engineer |
| Abdul-Swamad J. Hassan | T22-03-13834 | Documentation Engineer |

---

## License

Academic project developed for the Final Year Project requirement at the University of Dodoma. No open-source license is currently declared — contact the team before reuse.
