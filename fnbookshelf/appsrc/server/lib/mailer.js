// SMTP 邮件发送（nodemailer）
'use strict';
const nodemailer = require('nodemailer');

async function sendCode(smtpCfg, toEmail, code, siteName) {
  if (!smtpCfg || !smtpCfg.host || !smtpCfg.user) {
    const e = new Error('管理员尚未配置发件邮箱（SMTP），请联系管理员在设置中完成配置');
    e.status = 503;
    throw e;
  }
  const transporter = nodemailer.createTransport({
    host: smtpCfg.host,
    port: Number(smtpCfg.port) || 465,
    secure: String(smtpCfg.secure) !== 'false' && Number(smtpCfg.port || 465) === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass }
  });
  const from = smtpCfg.from || smtpCfg.user;
  await transporter.sendMail({
    from: `"${siteName || '飞牛书屋'}" <${from}>`,
    to: toEmail,
    subject: `【${siteName || '飞牛书屋'}】登录验证码：${code}`,
    text: `您的验证码是 ${code}，10 分钟内有效。如非本人操作请忽略本邮件。`,
    html: `<div style="max-width:480px;margin:0 auto;font-family:sans-serif;padding:32px;border:1px solid #eee;border-radius:12px">
      <h2 style="color:#1f2937;margin-top:0">${siteName || '飞牛书屋'}</h2>
      <p style="color:#4b5563;font-size:15px">您的登录验证码为：</p>
      <p style="font-size:36px;font-weight:700;letter-spacing:8px;color:#2563eb;margin:16px 0">${code}</p>
      <p style="color:#9ca3af;font-size:13px">验证码 10 分钟内有效。如非本人操作，请忽略本邮件。</p>
    </div>`
  });
}

async function sendTest(smtpCfg, toEmail, siteName) {
  const transporter = nodemailer.createTransport({
    host: smtpCfg.host,
    port: Number(smtpCfg.port) || 465,
    secure: String(smtpCfg.secure) !== 'false' && Number(smtpCfg.port || 465) === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass }
  });
  await transporter.sendMail({
    from: `"${siteName || '飞牛书屋'}" <${smtpCfg.from || smtpCfg.user}>`,
    to: toEmail,
    subject: `【${siteName || '飞牛书屋'}】测试邮件`,
    text: '这是一封测试邮件，SMTP 配置成功。'
  });
}

// 1.4.1 起不再发送「系统日志报告」邮件；本模块只负责登录验证码与 SMTP 连通性测试。
module.exports = { sendCode, sendTest };
