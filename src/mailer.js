// mailer.js — mails de LumoBi (diseno claro, mail-claro, mail-logo): bienvenida, recupero de contrasena, confirmacion y avisos del Vigilante.
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

const FROM = process.env.SMTP_FROM || "LumoBi <hola@lumobi.com.ar>";
const BASE_URL = process.env.FRONTEND_URL || "https://lumobi.com.ar";
const AÑO = new Date().getFullYear();

// Colores de la marca
const TINTA = "#0A1628";
const AZUL = "#0A5BD3";
const CIAN = "#00C2FF";
const TEXTO = "#334155";
const SUAVE = "#64748B";
const LINEA = "#E2E8F0";
const FONDO = "#F1F5F9";
const FUENTE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Utilidades de template ───────────────────────────────────────────────────

const LOGO_URL = process.env.LOGO_URL || "https://lumobi.com.ar/brand/lumobi-logo-email.png";

function logoBlock() {
  return `
  <div style="margin-bottom:28px;">
    <img src="${LOGO_URL}" width="148" height="38" alt="LumoBi" style="display:block;border:0;outline:none;height:auto;max-width:148px;font-size:26px;font-weight:800;color:${TINTA};font-family:${FUENTE};">
  </div>`;
}

function botonBlock(url, texto) {
  return `
    <a href="${escHtml(url)}"
       style="display:inline-block;padding:14px 28px;background:${AZUL};border-radius:10px;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:700;font-family:${FUENTE};">
      ${escHtml(texto)}
    </a>`;
}

function footerBlock(extra = "") {
  return `
  <div style="margin-top:36px;padding-top:20px;border-top:1px solid ${LINEA};">
    ${extra ? `<p style="color:${SUAVE};font-size:13px;line-height:1.6;margin:0 0 14px;">${extra}</p>` : ""}
    <p style="color:${TINTA};font-size:13px;margin:0 0 2px;font-weight:700;">El equipo de LumoBi</p>
    <p style="color:${SUAVE};font-size:12px;margin:0;">hola@lumobi.com.ar · lumobi.com.ar</p>
  </div>`;
}

function wrapper(content) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background:${FONDO};font-family:${FUENTE};">
  <div style="max-width:560px;margin:0 auto;padding:28px 14px;">
    <div style="background:#FFFFFF;border:1px solid ${LINEA};border-radius:16px;padding:32px 28px;">
      ${content}
    </div>
    <p style="color:${SUAVE};font-size:11px;text-align:center;margin:16px 0 0;">LumoBi · ${AÑO}</p>
  </div>
</body>
</html>`;
}

// ─── 1. Bienvenida ────────────────────────────────────────────────────────────

const COPY_NEGOCIO = {
  kiosko: {
    frase: "Cada turno cuenta. Literalmente.",
    cuerpo: "En un kiosko el efectivo rota rápido y los desvíos son chiquitos, pero LumoBi los detecta igual. Con el tiempo, el sistema aprende cómo funciona tu negocio y distingue un error genuino de un patrón que se repite.",
  },
  almacen: {
    frase: "El almacén que no mide, pierde sin saberlo.",
    cuerpo: "Con volumen de transacciones moderado, cada inconsistencia pesa más. LumoBi cruza caja, ventas y pagos digitales en cada turno para que ningún desvío pase desapercibido.",
  },
  cafeteria: {
    frase: "El café está servido. Los números también.",
    cuerpo: "En cafetería el efectivo y el digital se mezclan todo el tiempo. LumoBi los separa, los cruza y te avisa cuando el ratio no cierra, sin acusaciones y con evidencia.",
  },
  restaurante: {
    frase: "Tu negocio trabaja duro. Que los números trabajen para vos.",
    cuerpo: "Restaurante implica varios mozos, turnos largos y tickets altos. El contexto importa: día, turno, clima. LumoBi lo tiene todo en cuenta antes de emitir una alerta.",
  },
  parrilla: {
    frase: "Fuego lento, control en tiempo real.",
    cuerpo: "Ticket alto y mucha rotación de efectivo. Si hay desvíos, LumoBi los detecta antes de que se acumulen, turno a turno y local por local.",
  },
  panaderia: {
    frase: "Hecho con cuidado, desde el primer turno.",
    cuerpo: "La panadería arranca temprano y los conteos de caja se pierden fácil en el apuro. LumoBi los registra, los cruza y construye el historial que hace que las alertas sean precisas.",
  },
  farmacia: {
    frase: "Precisión en cada despacho. También en cada turno.",
    cuerpo: "Farmacia tiene poco efectivo pero muchas transacciones. LumoBi detecta anomalías en la relación efectivo/digital y en el ticket promedio, señales que a simple vista pasan inadvertidas.",
  },
  retail: {
    frase: "Más local, más control.",
    cuerpo: "En retail el ticketing es rápido y el efectivo se acumula durante el turno. LumoBi te avisa cuando el cierre no cuadra con el volumen del día.",
  },
  default: {
    frase: "Tu negocio, bajo control desde el primer turno.",
    cuerpo: "LumoBi cruza tus ventas, tu caja y tus pagos digitales para detectar cualquier inconsistencia antes de que se acumule, con contexto estadístico real y sin acusaciones.",
  },
};

async function enviarBienvenida({ nombre, email, negocio, tipo_negocio }) {
  if (!process.env.SMTP_USER) return;

  const copy = COPY_NEGOCIO[tipo_negocio] || COPY_NEGOCIO.default;

  const pasos = [
    "Cargá tus productos en el catálogo",
    "Armá tu equipo en «Caja del local»: nombre y PIN de cada empleado",
    "Subí tus ventas o conectá Mercado Pago",
    "Dejá que NICOLE aprenda de cada turno: el historial hace que los avisos sean precisos",
  ];

  const html = wrapper(`
    ${logoBlock()}

    <h1 style="color:${TINTA};font-size:24px;font-weight:700;margin:0 0 8px;line-height:1.3;">
      Bienvenido, ${escHtml(nombre)}
    </h1>
    <p style="color:${AZUL};font-size:16px;font-weight:600;margin:0 0 22px;line-height:1.5;">
      ${copy.frase}
    </p>

    <p style="color:${TEXTO};font-size:15px;line-height:1.7;margin:0 0 14px;">
      Registraste <strong style="color:${TINTA};">${escHtml(negocio)}</strong> en LumoBi.
      A partir de ahora, cada turno que registres alimenta el sistema de detección.
    </p>
    <p style="color:${TEXTO};font-size:15px;line-height:1.7;margin:0 0 28px;">
      ${copy.cuerpo}
    </p>

    ${botonBlock(BASE_URL + "/onboarding", "Completar la configuración")}

    <div style="margin-top:32px;background:${FONDO};border-radius:12px;padding:20px 20px;">
      <p style="color:${TINTA};font-size:14px;font-weight:700;margin:0 0 14px;">Tus primeros pasos</p>
      ${pasos.map((paso, i) => `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:${i < pasos.length - 1 ? "12px" : "0"};">
        <tr>
          <td valign="top" style="padding-right:12px;">
            <div style="width:24px;height:24px;line-height:24px;border-radius:50%;background:${AZUL};color:#FFFFFF;font-size:12px;font-weight:700;text-align:center;">${i + 1}</div>
          </td>
          <td valign="top" style="color:${TEXTO};font-size:14px;line-height:1.6;padding-top:2px;">${paso}</td>
        </tr>
      </table>`).join("")}
    </div>

    ${footerBlock("Cualquier duda, respondé a este mail.")}
  `);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: `Bienvenido a LumoBi, ${nombre}`,
    html,
  });
}

// ─── 2. Recupero de contraseña ────────────────────────────────────────────────

async function enviarRecupero({ nombre, email, resetUrl }) {
  if (!process.env.SMTP_USER) return;

  const html = wrapper(`
    ${logoBlock()}

    <h1 style="color:${TINTA};font-size:22px;font-weight:700;margin:0 0 12px;">
      Recuperá tu acceso
    </h1>
    <p style="color:${TEXTO};font-size:15px;line-height:1.7;margin:0 0 10px;">
      Hola ${escHtml(nombre)}, recibimos una solicitud para cambiar la contraseña de tu cuenta de LumoBi.
    </p>
    <p style="color:${TEXTO};font-size:15px;line-height:1.7;margin:0 0 28px;">
      El link es válido por <strong style="color:${TINTA};">1 hora</strong>.
      Si no lo pediste vos, ignorá este mail: tu cuenta sigue protegida.
    </p>

    ${botonBlock(resetUrl, "Cambiar mi contraseña")}

    <div style="margin-top:28px;background:${FONDO};border-radius:10px;padding:14px 16px;">
      <p style="color:${SUAVE};font-size:12px;margin:0 0 6px;">
        ¿El botón no funciona? Copiá y pegá este link en tu navegador:
      </p>
      <p style="color:${AZUL};font-size:12px;word-break:break-all;margin:0;line-height:1.5;">
        ${escHtml(resetUrl)}
      </p>
    </div>

    ${footerBlock()}
  `);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: "Cambiá tu contraseña de LumoBi",
    html,
  });
}

// ─── 3. Confirmación de cambio de contraseña ──────────────────────────────────

async function enviarConfirmacionReset({ nombre, email }) {
  if (!process.env.SMTP_USER) return;

  const html = wrapper(`
    ${logoBlock()}

    <h1 style="color:${TINTA};font-size:22px;font-weight:700;margin:0 0 12px;">
      Tu contraseña fue actualizada
    </h1>
    <p style="color:${TEXTO};font-size:15px;line-height:1.7;margin:0 0 10px;">
      Hola ${escHtml(nombre)}, la contraseña de tu cuenta de LumoBi se cambió correctamente.
    </p>
    <p style="color:${TEXTO};font-size:15px;line-height:1.7;margin:0 0 28px;">
      Si no fuiste vos, <strong style="color:#B91C1C;">escribinos enseguida</strong> respondiendo este mail.
    </p>

    ${botonBlock(BASE_URL + "/login", "Iniciar sesión")}

    ${footerBlock()}
  `);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: "Tu contraseña de LumoBi fue actualizada",
    html,
  });
}

// ─── Aviso del Vigilante (avisos proactivos al dueño) ─────────────────────────

async function enviarAvisoVigilante({ nombre, email, negocio, titulo, mensaje, url, boton }) {
  if (!process.env.SMTP_USER || !email) return false;

  const html = wrapper(`
    ${logoBlock()}

    <p style="color:${SUAVE};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 10px;">${escHtml(negocio || "Tu negocio")}</p>
    <h1 style="color:${TINTA};font-size:22px;font-weight:700;margin:0 0 14px;line-height:1.3;">
      ${escHtml(titulo)}
    </h1>
    <p style="color:${TEXTO};font-size:15px;line-height:1.7;margin:0 0 28px;">
      ${escHtml(mensaje)}
    </p>

    ${botonBlock(url, boton || "Abrir LumoBi")}

    ${footerBlock("Estos avisos los genera NICOLE mirando lo habitual de tu negocio. Podés ajustarlos desde Ajustes.")}
  `);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: titulo,
    html,
  });
  return true;
}

module.exports = { enviarBienvenida, enviarRecupero, enviarConfirmacionReset, enviarAvisoVigilante };
