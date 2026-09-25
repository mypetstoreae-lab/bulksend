import { useState, useRef, useCallback } from 'react'

type SendState = 'idle' | 'running' | 'paused' | 'done'

interface SmtpConfig {
  host: string
  port: string
  username: string
  password: string
  encryption: 'TLS' | 'SSL' | 'STARTTLS' | 'None'
  fromName: string
  fromEmail: string
  replyTo: string
}

interface LogEntry {
  id: number
  time: string
  type: 'info' | 'success' | 'error' | 'warning'
  message: string
}

const defaultSmtp: SmtpConfig = {
  host: '',
  port: '587',
  username: '',
  password: '',
  encryption: 'TLS',
  fromName: '',
  fromEmail: '',
  replyTo: '',
}

function timeNow() {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

let logId = 0

function parseEmails(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map(e => e.trim())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
}

function SectionHeader({ num, title, icon }: { num: string; title: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-5">
      <div className="flex items-center justify-center w-7 h-7 rounded-md" style={{ background: 'rgba(62,255,160,0.1)', border: '1px solid rgba(62,255,160,0.2)' }}>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: '#3effa0' }}>{num}</span>
      </div>
      <div className="flex items-center gap-2">
        {icon}
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600, color: '#e8ecf2', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{title}</span>
      </div>
    </div>
  )
}

export default function App() {
  const [smtp, setSmtp] = useState<SmtpConfig>(defaultSmtp)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [recipientRaw, setRecipientRaw] = useState('')
  const [batchSize, setBatchSize] = useState('10')
  const [batchDelay, setBatchDelay] = useState('2')
  const [sendState, setSendState] = useState<SendState>('idle')
  const [sent, setSent] = useState(0)
  const [totalQueued, setTotalQueued] = useState(0)
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: logId++, time: timeNow(), type: 'info', message: 'Sender ready. Fill in the sections above and click Start.' },
  ])
  const [showPassword, setShowPassword] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<{ stop: boolean; pause: boolean }>({ stop: false, pause: false })
  const sentCountRef = useRef(0)

  const recipients = parseEmails(recipientRaw)

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs(prev => {
      const next = [...prev, { id: logId++, time: timeNow(), type, message }]
      setTimeout(() => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
      }, 50)
      return next
    })
  }, [])

  const smtpValid = !!(smtp.host.trim() && smtp.port.trim() && smtp.username.trim() && smtp.password.trim() && smtp.fromEmail.trim())
  const composeValid = !!(subject.trim() && body.trim())
  const recipientsValid = recipients.length > 0

  const pruneSentEmails = useCallback((countSent: number) => {
    setRecipientRaw(prev => {
      const all = parseEmails(prev)
      return all.slice(countSent).join('\n')
    })
  }, [])

  const isRunning = sendState === 'running'
  const isPaused = sendState === 'paused'
  const isActive = isRunning || isPaused
  const progress = totalQueued > 0 ? (sent / totalQueued) * 100 : 0

  const handleStart = async () => {
    if (isRunning || isPaused) return
    if (!smtpValid) { addLog('error', 'SMTP configuration is incomplete — fill in host, port, username, password and from email.'); return }
    if (!composeValid) { addLog('error', 'Subject and body are required.'); return }
    if (!recipientsValid) { addLog('error', 'No valid recipient emails found.'); return }

    const list = parseEmails(recipientRaw)
    const batch = Math.max(1, parseInt(batchSize) || 10)
    const delayMs = Math.max(0, parseFloat(batchDelay) || 2) * 1000

    abortRef.current = { stop: false, pause: false }
    setSendState('running')
    setTotalQueued(list.length)
    sentCountRef.current = 0
    setSent(0)

    addLog('info', `▶ Campaign started — ${list.length} recipients, batch ${batch}, ${batchDelay}s delay`)
    addLog('info', `SMTP: ${smtp.host}:${smtp.port} (${smtp.encryption}) · from ${smtp.fromEmail}`)
    if (smtp.replyTo) addLog('info', `Reply-To: ${smtp.replyTo}`)

    let i = 0
    while (i < list.length) {
      if (abortRef.current.stop) {
        addLog('warning', `⏹ Stopped at ${sentCountRef.current}/${list.length}. Sent addresses removed from list.`)
        pruneSentEmails(sentCountRef.current)
        setSendState('idle')
        setSent(0)
        return
      }

      if (abortRef.current.pause) {
        addLog('warning', `⏸ Paused at ${sentCountRef.current}/${list.length}. Sent addresses removed from list.`)
        pruneSentEmails(sentCountRef.current)
        setSendState('paused')
        await new Promise<void>(resolve => {
          const check = setInterval(() => {
            if (!abortRef.current.pause || abortRef.current.stop) {
              clearInterval(check)
              resolve()
            }
          }, 100)
        })
        if (abortRef.current.stop) {
          addLog('warning', `⏹ Stopped after pause.`)
          setSendState('idle')
          setSent(0)
          return
        }
        const refreshed = parseEmails(recipientRaw)
        addLog('info', `▶ Resumed — ${refreshed.length} remaining`)
        setSendState('running')
        list.length = 0
        refreshed.forEach(e => list.push(e))
        i = 0
        sentCountRef.current = 0
        setSent(0)
        setTotalQueued(refreshed.length)
        continue
      }

      const batchEnd = Math.min(i + batch, list.length)
      const currentBatch = list.slice(i, batchEnd)
      addLog('info', `── Batch ${Math.floor(i / batch) + 1} of ${Math.ceil(list.length / batch)} (${currentBatch.length} emails)`)

      for (const email of currentBatch) {
        if (abortRef.current.stop || abortRef.current.pause) break
        try {
          const res = await fetch('http://localhost:3001/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              smtp,
              subject,
              body,
              recipient: email,
              fromName: smtp.fromName,
              fromEmail: smtp.fromEmail,
              replyTo: smtp.replyTo,
            }),
          })
          const data = await res.json()
          if (data.success) {
            addLog('success', `✓ ${email}`)
          } else {
            addLog('error', `✗ ${email} — ${data.error}`)
          }
        } catch {
          addLog('error', `✗ ${email} — could not reach server`)
        }
        sentCountRef.current++
        setSent(c => c + 1)
      }

      i = batchEnd

      if (i < list.length && !abortRef.current.stop && !abortRef.current.pause && delayMs > 0) {
        addLog('info', `⏱ Waiting ${batchDelay}s…`)
        await new Promise(r => setTimeout(r, delayMs))
      }
    }

    if (!abortRef.current.stop && !abortRef.current.pause) {
      addLog('success', `✅ Done — ${sentCountRef.current} emails processed.`)
      pruneSentEmails(sentCountRef.current)
      setSendState('done')
    }
  }

  const handlePause = () => { if (isRunning) abortRef.current.pause = true }
  const handleResume = () => { if (isPaused) abortRef.current.pause = false }
  const handleStop = () => {
    abortRef.current.stop = true
    abortRef.current.pause = false
    if (sendState === 'done') { setSendState('idle'); setSent(0) }
  }

  const logColor: Record<LogEntry['type'], string> = {
    info: '#6b7592', success: '#3effa0', error: '#ff4d6a', warning: '#ffb347',
  }

  const inputStyle: React.CSSProperties = {
    background: '#0d0f12',
    border: '1px solid #252a38',
    borderRadius: 6,
    padding: '10px 14px',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 13,
    color: '#e8ecf2',
    width: '100%',
    outline: 'none',
  }

  const labelStyle: React.CSSProperties = {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#6b7592',
    marginBottom: 6,
    display: 'block',
  }

  const panelStyle: React.CSSProperties = {
    background: '#151820',
    border: '1px solid #252a38',
    borderRadius: 12,
    padding: '28px 28px',
    marginBottom: 16,
  }

  return (
    <div style={{ background: '#0d0f12', minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 20px 80px' }}>

        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(62,255,160,0.1)', border: '1px solid rgba(62,255,160,0.25)' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="#3effa0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <polyline points="22,6 12,13 2,6" stroke="#3effa0" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <h1 style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 20, fontWeight: 700, color: '#e8ecf2', margin: 0, letterSpacing: '-0.01em' }}>BulkSend</h1>
              <p style={{ fontSize: 13, color: '#6b7592', margin: 0 }}>SMTP bulk mailer · reply routing</p>
            </div>
          </div>
          {/* Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999, background: '#151820', border: '1px solid #252a38' }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
              background: isRunning ? '#3effa0' : isPaused ? '#ffb347' : sendState === 'done' ? '#4d9fff' : smtpValid ? '#3effa0' : '#404760',
              animation: isRunning ? 'blink 1.2s ease-in-out infinite' : 'none',
            }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#6b7592' }}>
              {isRunning ? `SENDING ${sent}/${totalQueued}` : isPaused ? 'PAUSED' : sendState === 'done' ? 'DONE' : smtpValid ? 'READY' : 'SETUP'}
            </span>
          </div>
        </div>

        {/* ── Progress bar (visible while active) ── */}
        {isActive && totalQueued > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: isPaused ? '#ffb347' : '#6b7592' }}>
                {isPaused ? '⏸ PAUSED' : '▶ SENDING'}
              </span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: isPaused ? '#ffb347' : '#3effa0' }}>
                {sent}/{totalQueued} · {Math.round(progress)}%
              </span>
            </div>
            <div style={{ height: 3, background: '#1c2030', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 99,
                width: `${progress}%`,
                background: isPaused ? 'linear-gradient(90deg,#ffb347,#cc7a00)' : 'linear-gradient(90deg,#3effa0,#1a7a4d)',
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>
        )}

        {/* ── Two-column layout ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* LEFT COLUMN */}
          <div>
            {/* ── 1. SMTP ── */}
            <div style={panelStyle}>
              <SectionHeader num="01" title="SMTP Server"
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7592" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={labelStyle}>Host</label>
                  <input style={inputStyle} placeholder="smtp.gmail.com" value={smtp.host} onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))} className="input-field" />
                </div>
                <div>
                  <label style={labelStyle}>Port</label>
                  <input style={inputStyle} placeholder="587" value={smtp.port} onChange={e => setSmtp(s => ({ ...s, port: e.target.value }))} className="input-field" />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={labelStyle}>Username</label>
                <input style={inputStyle} placeholder="you@domain.com" value={smtp.username} onChange={e => setSmtp(s => ({ ...s, username: e.target.value }))} className="input-field" />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={labelStyle}>Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    style={{ ...inputStyle, paddingRight: 42 }}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="App password or SMTP key"
                    value={smtp.password}
                    onChange={e => setSmtp(s => ({ ...s, password: e.target.value }))}
                    className="input-field"
                  />
                  <button onClick={() => setShowPassword(v => !v)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#6b7592', padding: 2 }}>
                    {showPassword
                      ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>
              <div>
                <label style={labelStyle}>Encryption</label>
                <select style={{ ...inputStyle, appearance: 'none' as const }} value={smtp.encryption} onChange={e => setSmtp(s => ({ ...s, encryption: e.target.value as SmtpConfig['encryption'] }))} className="input-field">
                  <option>TLS</option><option>SSL</option><option>STARTTLS</option><option>None</option>
                </select>
              </div>
            </div>

            {/* ── 2. Sender Identity ── */}
            <div style={panelStyle}>
              <SectionHeader num="02" title="Sender Identity"
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7592" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
              />
              <div style={{ marginBottom: 10 }}>
                <label style={labelStyle}>From Name</label>
                <input style={inputStyle} placeholder="Your Name or Brand" value={smtp.fromName} onChange={e => setSmtp(s => ({ ...s, fromName: e.target.value }))} className="input-field" />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>From Email</label>
                <input style={inputStyle} placeholder="sender@domain.com" value={smtp.fromEmail} onChange={e => setSmtp(s => ({ ...s, fromEmail: e.target.value }))} className="input-field" />
              </div>

              {/* Reply-To highlight */}
              <div style={{ background: 'rgba(62,255,160,0.04)', border: '1px solid rgba(62,255,160,0.18)', borderRadius: 8, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3effa0" strokeWidth="2.5"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                  <span style={{ ...labelStyle, color: '#3effa0', marginBottom: 0 }}>Reply-To</span>
                </div>
                <input
                  style={{ ...inputStyle, borderColor: smtp.replyTo ? 'rgba(62,255,160,0.35)' : '#252a38' }}
                  placeholder="yourpersonal@gmail.com"
                  value={smtp.replyTo}
                  onChange={e => setSmtp(s => ({ ...s, replyTo: e.target.value }))}
                  className="input-field"
                />
                <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#6b7592', marginTop: 6, marginBottom: 0 }}>
                  All replies land here, not the From address.
                </p>
              </div>
            </div>

            {/* ── 3. Batch Settings ── */}
            <div style={panelStyle}>
              <SectionHeader num="03" title="Batch Settings"
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7592" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={labelStyle}>Emails per batch</label>
                  <input style={inputStyle} type="number" min="1" max="500" placeholder="10" value={batchSize} onChange={e => setBatchSize(e.target.value)} disabled={isActive} className="input-field" />
                </div>
                <div>
                  <label style={labelStyle}>Delay (seconds)</label>
                  <input style={inputStyle} type="number" min="0" step="0.5" placeholder="2" value={batchDelay} onChange={e => setBatchDelay(e.target.value)} disabled={isActive} className="input-field" />
                </div>
              </div>
              {recipients.length > 0 && (
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#6b7592', padding: '10px 12px', background: '#0d0f12', borderRadius: 6, border: '1px solid #1c2030' }}>
                  {Math.ceil(recipients.length / Math.max(1, parseInt(batchSize) || 10))} batches
                  {' · '}~{(Math.ceil(recipients.length / Math.max(1, parseInt(batchSize) || 10)) * (parseFloat(batchDelay) || 2)).toFixed(0)}s total delay
                </div>
              )}
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div>
            {/* ── 4. Compose ── */}
            <div style={panelStyle}>
              <SectionHeader num="04" title="Message"
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7592" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
              />
              <div style={{ marginBottom: 10 }}>
                <label style={labelStyle}>Subject</label>
                <input style={inputStyle} placeholder="Your email subject line…" value={subject} onChange={e => setSubject(e.target.value)} className="input-field" />
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Body</label>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#404760' }}>{body.length} chars</span>
                </div>
                <textarea
                  style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.65, minHeight: 180 }}
                  placeholder={"Hi {{name}},\n\nWrite your message here…\n\nBest,\nYour Name"}
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  rows={9}
                  className="input-field"
                />
                <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#6b7592', marginTop: 6 }}>
                  Merge tags: <span style={{ color: '#ffb347' }}>{'{{name}}'}</span> · <span style={{ color: '#ffb347' }}>{'{{email}}'}</span>
                </p>
              </div>
            </div>

            {/* ── 5. Recipients ── */}
            <div style={panelStyle}>
              <SectionHeader num="05" title="Recipients"
                icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7592" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>Email list</label>
                {recipients.length > 0 && (
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, background: 'rgba(62,255,160,0.1)', color: '#3effa0', padding: '2px 8px', borderRadius: 4 }}>
                    {recipients.length} valid
                  </span>
                )}
              </div>
              <textarea
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.7, minHeight: 160 }}
                placeholder={"Paste emails — one per line or comma/semicolon separated:\n\nalice@example.com\nbob@example.com, carol@example.com"}
                value={recipientRaw}
                onChange={e => setRecipientRaw(e.target.value)}
                rows={7}
                disabled={isActive}
                className="input-field"
              />
              {recipientRaw.trim() && (() => {
                const total = recipientRaw.split(/[\n,;]+/).filter(e => e.trim()).length
                const invalid = total - recipients.length
                return invalid > 0 ? (
                  <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#ff4d6a', marginTop: 6 }}>
                    {invalid} invalid address{invalid !== 1 ? 'es' : ''} skipped
                  </p>
                ) : null
              })()}
            </div>
          </div>
        </div>

        {/* ── Activity Log ── */}
        <div style={{ ...panelStyle, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <SectionHeader num="06" title="Activity Log"
              icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7592" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
            />
            <button
              onClick={() => setLogs([{ id: logId++, time: timeNow(), type: 'info', message: 'Log cleared.' }])}
              style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#6b7592', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px' }}
            >
              clear
            </button>
          </div>
          <div
            ref={logRef}
            style={{ background: '#0a0c0f', border: '1px solid #1c2030', borderRadius: 8, padding: '14px 16px', height: 220, overflowY: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.8 }}
          >
            {logs.map(entry => (
              <div key={entry.id} style={{ display: 'flex', gap: 14 }}>
                <span style={{ color: '#404760', flexShrink: 0 }}>{entry.time}</span>
                <span style={{ color: logColor[entry.type] }}>{entry.message}</span>
              </div>
            ))}
            {isRunning && (
              <div style={{ display: 'flex', gap: 14 }}>
                <span style={{ color: '#404760' }}>{timeNow()}</span>
                <span style={{ color: '#6b7592', animation: 'blink 1.2s ease-in-out infinite' }}>▋</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Control Bar ── */}
        <div style={{ background: '#151820', border: '1px solid #252a38', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Checklist */}
          <div style={{ display: 'flex', gap: 16, flex: 1, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>
            <span style={{ color: smtpValid ? '#3effa0' : '#404760' }}>{smtpValid ? '✓' : '○'} SMTP</span>
            <span style={{ color: composeValid ? '#3effa0' : '#404760' }}>{composeValid ? '✓' : '○'} Message</span>
            <span style={{ color: recipientsValid ? '#3effa0' : '#404760' }}>{recipientsValid ? '✓' : '○'} {recipients.length} recip.</span>
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: 8 }}>
            {/* START */}
            <button
              onClick={handleStart}
              style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 600,
                background: (!isActive && smtpValid && composeValid && recipientsValid) ? '#3effa0' : '#1c2030',
                color: (!isActive && smtpValid && composeValid && recipientsValid) ? '#0a0c0f' : '#6b7592',
                border: 'none', borderRadius: 8, cursor: 'pointer',
                padding: '10px 22px', display: 'flex', alignItems: 'center', gap: 7,
                boxShadow: (!isActive && smtpValid && composeValid && recipientsValid) ? '0 0 24px rgba(62,255,160,0.25)' : 'none',
                transition: 'all 0.15s',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Start
            </button>

            {/* PAUSE / RESUME */}
            {isPaused ? (
              <button
                onClick={handleResume}
                style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 600,
                  background: 'rgba(255,179,71,0.12)', color: '#ffb347',
                  border: '1px solid rgba(255,179,71,0.3)', borderRadius: 8, cursor: 'pointer',
                  padding: '10px 22px', display: 'flex', alignItems: 'center', gap: 7, transition: 'all 0.15s',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Resume
              </button>
            ) : (
              <button
                onClick={handlePause}
                style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 600,
                  background: isRunning ? 'rgba(255,179,71,0.12)' : '#1c2030',
                  color: isRunning ? '#ffb347' : '#404760',
                  border: isRunning ? '1px solid rgba(255,179,71,0.3)' : '1px solid transparent',
                  borderRadius: 8, cursor: 'pointer',
                  padding: '10px 22px', display: 'flex', alignItems: 'center', gap: 7, transition: 'all 0.15s',
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                Pause
              </button>
            )}

            {/* STOP */}
            <button
              onClick={handleStop}
              style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 600,
                background: isActive ? 'rgba(255,77,106,0.1)' : '#1c2030',
                color: isActive ? '#ff4d6a' : '#404760',
                border: isActive ? '1px solid rgba(255,77,106,0.3)' : '1px solid transparent',
                borderRadius: 8, cursor: 'pointer',
                padding: '10px 22px', display: 'flex', alignItems: 'center', gap: 7, transition: 'all 0.15s',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Stop
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
