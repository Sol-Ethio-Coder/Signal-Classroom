# Signal Classroom

A live teaching room: video, screen share, shared whiteboard, chat, polls, raise-hand, a shared code pad with a JavaScript runner, lesson recording and attendance. **No signup or login for students.** You (the admin) unlock `/admin` with one secret key.

## How access works
| Who | How they get in |
|---|---|
| Admin | Types `/admin` in the address bar and signs in with `ADMIN_USER` + `ADMIN_PASSWORD` from `.env` (no link to it anywhere on the site) |
| Teacher | Opens the private **teacher link** (`/r/CODE#h=TOKEN`) made by the admin panel |
| Student | Types the 6-character **class code** (or opens `/r/CODE`) and a display name |

The teacher token sits in the URL hash, so it is never sent to the server in a request log. Anyone with the teacher link controls the class: share it only with co-teachers.

## Run it
```bash
npm install
npm run setup     # asks for your admin username + password and writes .env
npm start         # http://localhost:3000  ·  admin at /admin
```
The server reads `.env` by itself (no extra tools). On a host such as Render, set `ADMIN_USER` and `ADMIN_PASSWORD` in its Environment settings instead.
Camera and microphone need **HTTPS** (localhost is exempt).

## Admin page
Open `/admin` (type the address; it is deliberately not linked), sign in, and use the **Setup checklist** at the top: it flags a temporary or short password, missing HTTPS, no TURN relay, and a non-persistent data folder. Then create a class, click **Enter as teacher**, and share the student link or the 6-character code.

## Courses
`/courses` lists the courses and `/course?c=maths` is the lesson viewer: key ideas, worked examples, auto-checked practice, quizzes, progress saved in the student's browser, and a print/save-as-PDF button. The included course is **High School Mathematics** (14 lessons, about 6.75 hours, 5 modules). Its content lives in `public/content/maths.json`, so you can edit lessons or add `public/content/<id>.json` plus an entry in `public/content/index.json` to add a new course.
Inside a live class the teacher's **Class** tab has a **Course library**: send a lesson outline to the shared pad, or ask a lesson's quiz question as a poll (the correct answer is shown only to the teacher).

## Look and feel
Dark and light themes (follows your OS the first time, then remembers your choice) via the toggle on every page. Favicon is `public/favicon.svg`. The developer credit links to https://sol-ethio-coder.netlify.app.

## Deploy: Vercel (pages) + Render (live server)
Vercel cannot run this server: classes need one long-running process that holds the room state. So the pages go on Vercel and the Socket.io server goes on Render.

1. **Push to GitHub** (see the commands in the chat or below).
2. **Render** (server): New → Blueprint (or Web Service) → pick the repo. Set `ADMIN_USER`, `ADMIN_PASSWORD`. Leave `CORS_ORIGIN` empty for now. Copy the `https://….onrender.com` address.
3. **Point the pages at the server:** edit `public/config.js` → `window.SIGNAL_API = 'https://….onrender.com';` then commit and push.
4. **Vercel** (pages): Add New Project → pick the repo → **Root Directory: `public`**, Framework Preset: **Other**, no build command → Deploy. `public/vercel.json` handles `/admin`, `/courses`, `/course` and `/r/CODE`.
5. Back on Render, set `CORS_ORIGIN` to your Vercel address (e.g. `https://signal-classroom.vercel.app`, no trailing slash; add a custom domain here too if you use one). Render redeploys.
6. Open `https://your-site.vercel.app/admin` and sign in.

Render's free plan sleeps after 15 idle minutes (about a minute to wake) and forgets classes whenever it restarts, because it has no persistent disk. Fine for testing. For real teaching use a paid instance with a persistent disk (set `DATA_DIR`). Check current prices on render.com.
You can also skip Vercel entirely: the Render address serves the whole site by itself.

## TURN server (important)
Video uses direct peer connections. On mobile data or strict networks some students will not connect with STUN alone. Add a TURN relay (`TURN_URL`, `TURN_USER`, `TURN_PASS`): Metered.ca has a free tier, or self-host coturn.

## Features
- Whiteboard: pen, highlighter, eraser, line, rectangle, ellipse, arrow, text, laser pointer, undo/redo, multiple pages, 4 backgrounds, save PNG. Late joiners get the full board. Boards persist between sessions.
- Teacher controls: lock class, lock chat, allow students to draw or share screen, per-student mute / camera off / drawing permission / spotlight / remove, mute all, end class.
- Students: raise hand, reactions, private question to the teacher, file sharing (2 MB).
- Polls, countdown timer, shared notes/code pad with sandboxed **Run JavaScript**.
- Lesson recording (teacher's device): board + mixed audio to `.webm`. Everyone sees a Recording badge.
- Admin: create/end/reopen/delete classes, optional class password, attendance table + CSV, clear board.

## Known limits (be honest with yourself)
- Mesh WebRTC is fine for about 6–8 cameras. Beyond that move media to an SFU (LiveKit, mediasoup).
- "Mute" and "camera off" are requests the student's browser obeys; in a peer-to-peer design the server cannot cut media itself.
- Recording mixes the audio of people present when you press record.
- Chat history is kept in memory while the class is live, not on disk.

## Files
```
server.js            Express + Socket.io, admin API, moderation, board state
public/index.html    landing (join by code)
public/admin.html/js class management + attendance
public/room.html     the classroom
public/room.js       WebRTC mesh, UI, chat, polls, pad, recording
public/whiteboard.js drawing engine
public/site.css       homepage + course styling
public/site.js        reveal animations, join form
public/courses.html   course library page
public/course.html/js lesson viewer
public/content/       course data (maths.json, index.json)
public/style.css      dark/light theme variables
public/theme.js       theme toggle (loaded in <head>)
public/favicon.svg
scripts/setup.js      npm run setup → asks for admin username + password, writes .env
```
