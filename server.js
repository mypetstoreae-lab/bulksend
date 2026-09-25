import express from 'express'
import nodemailer from 'nodemailer'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

app.post('/send', async (req, res) => {
  const { smtp, subject, body, recipient, fromName, fromEmail, replyTo } = req.body

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: parseInt(smtp.port),
      secure: smtp.encryption === 'SSL',
      requireTLS: smtp.encryption === 'STARTTLS',
      auth: {
        user: smtp.username,
        pass: smtp.password,
      },
      tls: {
        rejectUnauthorized: false,
      },
    })

    const mailOptions = {
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to: recipient,
      subject,
      text: body,
      ...(replyTo ? { replyTo } : {}),
    }

    await transporter.sendMail(mailOptions)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.listen(3001, () => {
  console.log('BulkSend server running on http://localhost:3001')
})
