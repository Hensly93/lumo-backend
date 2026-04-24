const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false, // STARTTLS en puerto 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM || "LUMO <noreply@lumo.app>";
const BASE_URL = process.env.FRONTEND_URL || "https://lumo-psi.vercel.app";
const AÑO = new Date().getFullYear();

// ─── Utilidades de template ───────────────────────────────────────────────────

function logoBlock() {
  return `
  <div style="margin-bottom:36px;">
    <span style="font-size:26px;font-weight:800;color:#E8F4FF;letter-spacing:-1px;font-family:system-ui,sans-serif;">LUMO</span><span style="display:inline-block;width:5px;height:5px;background:#38BDF8;border-radius:50%;margin-left:3px;margin-bottom:6px;vertical-align:middle;"></span>
    <div style="width:80px;height:1px;background:linear-gradient(90deg,transparent,#38BDF8,transparent);margin-top:6px;"></div>
  </div>`;
}

function footerBlock(extra = "") {
  return `
  <div style="margin-top:48px;padding-top:20px;border-top:1px solid #0E2340;">
    ${extra ? `<p style="color:#4A7A9B;font-size:13px;line-height:1.6;margin:0 0 16px;">${extra}</p>` : ""}
    <p style="color:#4A7A9B;font-size:13px;margin:0 0 4px;font-weight:600;">El equipo de Lumo</p>
    <p style="color:#1E3A5F;font-size:11px;font-family:monospace;letter-spacing:1px;margin:0;">
      LUMO · BETA · ${AÑO}
    </p>
  </div>`;
}

function wrapper(content) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
</head>
<body style="margin:0;padding:0;background:#050D1A;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:540px;margin:0 auto;padding:40px 28px;">
    ${content}
  </div>
</body>
</html>`;
}

// ─── 1. Bienvenida ────────────────────────────────────────────────────────────

const COPY_NEGOCIO = {
  kiosko: {
    frase: "Cada turno cuenta. Literalmente.",
    cuerpo: "En un kiosko el efectivo rota rápido y los desvíos son microscópicos — Lumo los detecta igual. Con el tiempo, el sistema aprende el ADN de tu negocio y puede distinguir un error genuino de un patrón que se repite.",
  },
  almacen: {
    frase: "El almacén que no mide, pierde sin saberlo.",
    cuerpo: "Con volumen de transacciones moderado, cada inconsistencia pesa más. Lumo cruza caja, ventas y pagos digitales en cada turno para que ningún desvío pase desapercibido.",
  },
  cafeteria: {
    frase: "El café está servido. Los números también.",
    cuerpo: "En cafetería el efectivo y el digital se mezclan todo el tiempo. Lumo los separa, los cruza y te avisa cuando el ratio no cierra — sin acusaciones, con evidencia.",
  },
  restaurante: {
    frase: "Tu negocio trabaja duro. Que los números trabajen para vos.",
    cuerpo: "Restaurante implica múltiples mozos, turnos largos y tickets altos. El contexto importa: día, turno, condición climática. Lumo lo tiene todo en cuenta antes de emitir una alerta.",
  },
  parrilla: {
    frase: "Fuego lento, control en tiempo real.",
    cuerpo: "Ticket alto y alta rotación de efectivo. Si hay desvíos, Lumo los detecta antes de que se acumulen — turno a turno, local por local.",
  },
  panaderia: {
    frase: "Hecho con cuidado, desde el primer turno.",
    cuerpo: "La panadería arranca temprano y los conteos de caja se pierden fácil en el apuro. Lumo los registra, los cruza y construye el historial que hace que las alertas sean precisas.",
  },
  farmacia: {
    frase: "Precisión en cada despacho. También en cada turno.",
    cuerpo: "Farmacia tiene bajo porcentaje de efectivo pero muchas transacciones. Lumo detecta anomalías en el ratio efectivo/digital y en el ticket promedio — señales que a simple vista pasan inadvertidas.",
  },
  retail: {
    frase: "Más local, más control.",
    cuerpo: "En retail el ticketing es rápido y el efectivo se acumula durante el turno. Lumo te avisa cuando el patrón de cierre no cuadra con el volumen del día.",
  },
  default: {
    frase: "Tu negocio, bajo control desde el primer turno.",
    cuerpo: "Lumo cruza tus ventas, tu caja y tus pagos digitales para detectar cualquier inconsistencia operativa antes de que se acumule — con contexto estadístico real, sin acusaciones.",
  },
};

async function enviarBienvenida({ nombre, email, negocio, tipo_negocio }) {
  if (!process.env.SMTP_USER) return;

  const copy = COPY_NEGOCIO[tipo_negocio] || COPY_NEGOCIO.default;

  const pasos = [
    "Completá la configuración de tu negocio en el onboarding",
    "Agregá a tus empleados con nombre y PIN",
    "Conectá Mercado Pago si lo usás (historial de 18 meses en un clic)",
    "El primer turno ya empieza a construir el historial estadístico",
  ];

  const html = wrapper(`
    ${logoBlock()}

    <h1 style="color:#E8F4FF;font-size:22px;font-weight:700;margin:0 0 6px;line-height:1.3;">
      Bienvenido, ${nombre}.
    </h1>
    <p style="color:#38BDF8;font-size:15px;font-style:italic;margin:0 0 28px;line-height:1.5;">
      "${copy.frase}"
    </p>

    <p style="color:#4A7A9B;font-size:14px;line-height:1.75;margin:0 0 14px;">
      Registraste <strong style="color:#E8F4FF;">${negocio}</strong> en Lumo.
      A partir de ahora, cada turno que registres alimenta el sistema de detección.
    </p>
    <p style="color:#4A7A9B;font-size:14px;line-height:1.75;margin:0 0 32px;">
      ${copy.cuerpo}
    </p>

    <a href="${BASE_URL}/onboarding"
       style="display:inline-block;padding:14px 28px;background:rgba(56,189,248,0.10);border:1px solid #38BDF8;border-radius:12px;color:#38BDF8;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:0.3px;">
      Completar configuración →
    </a>

    <div style="margin-top:40px;background:#071428;border:1px solid #0E2340;border-radius:14px;padding:22px 20px;">
      <p style="color:#1E3A5F;font-size:10px;font-family:monospace;letter-spacing:3px;text-transform:uppercase;margin:0 0 18px;">// PRIMEROS PASOS</p>
      ${pasos.map((paso, i) => `
      <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:${i < pasos.length - 1 ? "14px" : "0"};">
        <span style="color:#38BDF8;font-family:monospace;font-size:11px;font-weight:700;min-width:20px;margin-top:1px;">0${i + 1}</span>
        <span style="color:#4A7A9B;font-size:13px;line-height:1.6;">${paso}</span>
      </div>`).join("")}
    </div>

    ${footerBlock("Cualquier duda respondé a este mail — lo lee un humano.")}
  `);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: `Bienvenido a Lumo, ${nombre} 👋`,
    html,
  });
}

// ─── 2. Recupero de contraseña ────────────────────────────────────────────────

async function enviarRecupero({ nombre, email, resetUrl }) {
  if (!process.env.SMTP_USER) return;

  const html = wrapper(`
    ${logoBlock()}

    <h1 style="color:#E8F4FF;font-size:20px;font-weight:700;margin:0 0 10px;">
      Recuperá tu acceso
    </h1>
    <p style="color:#4A7A9B;font-size:14px;line-height:1.75;margin:0 0 8px;">
      Hola ${nombre}, recibimos una solicitud para resetear la contraseña de tu cuenta en Lumo.
    </p>
    <p style="color:#4A7A9B;font-size:14px;line-height:1.75;margin:0 0 32px;">
      Este link es válido por <strong style="color:#E8F4FF;">1 hora</strong>.
      Si no pediste el reset, ignorá este mail — tu cuenta sigue protegida.
    </p>

    <a href="${resetUrl}"
       style="display:inline-block;padding:14px 28px;background:rgba(56,189,248,0.10);border:1px solid #38BDF8;border-radius:12px;color:#38BDF8;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:0.3px;">
      Resetear contraseña →
    </a>

    <div style="margin-top:32px;background:#071428;border:1px solid #0E2340;border-radius:12px;padding:16px 18px;">
      <p style="color:#1E3A5F;font-size:11px;font-family:monospace;letter-spacing:1px;margin:0 0 6px;">
        ¿El botón no funciona? Copiá este link:
      </p>
      <p style="color:#1E3A5F;font-size:11px;word-break:break-all;margin:0;line-height:1.5;">
        ${resetUrl}
      </p>
    </div>

    ${footerBlock()}
  `);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: "Resetear contraseña de Lumo",
    html,
  });
}

// ─── 3. Confirmación de cambio de contraseña ──────────────────────────────────

async function enviarConfirmacionReset({ nombre, email }) {
  if (!process.env.SMTP_USER) return;

  const html = wrapper(`
    ${logoBlock()}

    <div style="text-align:center;margin-bottom:28px;">
      <div style="display:inline-block;width:48px;height:48px;background:rgba(52,211,153,0.10);border:1px solid rgba(52,211,153,0.3);border-radius:50%;line-height:48px;font-size:22px;">
        ✓
      </div>
    </div>

    <h1 style="color:#34D399;font-size:20px;font-weight:700;margin:0 0 10px;text-align:center;">
      Contraseña actualizada
    </h1>
    <p style="color:#4A7A9B;font-size:14px;line-height:1.75;margin:0 0 10px;text-align:center;">
      Hola ${nombre}, tu contraseña de Lumo fue cambiada exitosamente.
    </p>
    <p style="color:#4A7A9B;font-size:14px;line-height:1.75;margin:0 0 32px;text-align:center;">
      Si no fuiste vos, <strong style="color:#EF4444;">contactanos de inmediato</strong> respondiendo este mail.
    </p>

    <div style="text-align:center;">
      <a href="${BASE_URL}/login"
         style="display:inline-block;padding:14px 28px;background:rgba(56,189,248,0.10);border:1px solid #38BDF8;border-radius:12px;color:#38BDF8;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:0.3px;">
        Iniciar sesión →
      </a>
    </div>

    ${footerBlock()}
  `);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: "Contraseña de Lumo actualizada",
    html,
  });
}

module.exports = { enviarBienvenida, enviarRecupero, enviarConfirmacionReset };
