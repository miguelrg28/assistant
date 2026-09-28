import { html } from 'hono/html'

// Public privacy policy, required by Meta to publish the app. Plain facts about what this service does.
export const privacyPage = (updated: string) => html`<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Aviso de privacidad / Privacy policy</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.55; }
      body { max-width: 720px; margin: 6vh auto; padding: 0 16px; }
      h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
      hr { margin: 3rem 0; border: 0; border-top: 1px solid #8884; }
      .muted { opacity: .7; font-size: .9rem; }
    </style>
  </head>
  <body>
    <h1>Aviso de privacidad</h1>
    <p class="muted">Última actualización: ${updated}</p>
    <p>Este servicio es una herramienta interna y de solo lectura del titular de este número de WhatsApp Business. Guarda las conversaciones 1:1 de ese número para que el titular pueda consultarlas y buscarlas. No es un servicio público y no tiene usuarios externos.</p>
    <h2>Qué datos se guardan</h2>
    <ul>
      <li>Tu número de WhatsApp, tu nombre de perfil y, si el titular te tiene en su agenda, el nombre con el que te guardó.</li>
      <li>El texto de los mensajes intercambiados con el titular, su fecha y su estado de entrega.</li>
      <li>De archivos adjuntos solo se guardan datos descriptivos (tipo, nombre de archivo, pie de foto). Los archivos no se descargan.</li>
    </ul>
    <h2>Para qué se usan</h2>
    <p>Únicamente para que el titular consulte y busque sus propias conversaciones, incluso a través de un asistente de IA autorizado por él. Este servicio no envía mensajes, no hace publicidad y no vende ni comparte tus datos con terceros.</p>
    <h2>Seguridad y conservación</h2>
    <p>Los datos se almacenan cifrados en tránsito, en una base de datos privada a la que solo accede el titular con autenticación. Se conservan mientras el titular mantenga el servicio activo.</p>
    <h2>Tus derechos y eliminación de datos</h2>
    <p>Puedes pedir acceso, corrección o eliminación de tus datos escribiendo al mismo número de WhatsApp Business con el que conversaste. El titular eliminará tu contacto y todos tus mensajes de este servicio.</p>

    <hr />

    <h1>Privacy policy</h1>
    <p class="muted">Last updated: ${updated}</p>
    <p>This service is a private, read-only tool of the owner of this WhatsApp Business number. It stores that number's 1:1 conversations so the owner can review and search them. It is not a public service and has no outside users.</p>
    <h2>What is stored</h2>
    <ul>
      <li>Your WhatsApp number, profile name, and the name the owner saved you under, if any.</li>
      <li>The text of messages exchanged with the owner, their timestamps and delivery status.</li>
      <li>For attachments, only descriptive metadata (type, file name, caption). Files are not downloaded.</li>
    </ul>
    <h2>How it is used</h2>
    <p>Only so the owner can read and search their own conversations, including through an AI assistant they authorize. This service does not send messages, does not advertise, and does not sell or share your data with third parties.</p>
    <h2>Security and retention</h2>
    <p>Data is encrypted in transit and stored in a private database accessible only to the authenticated owner. Messages are deleted automatically once they are older than the retention period the owner sets (3 to 12 months; 12 by default). Raw webhook deliveries are deleted a week after they are processed.</p>
    <h2>Your rights and data deletion</h2>
    <p>To request access, correction or deletion, message the same WhatsApp Business number you chatted with. The owner will delete your contact and all of your messages from this service and exclude your number, so future messages are not stored either.</p>
  </body>
</html>`
