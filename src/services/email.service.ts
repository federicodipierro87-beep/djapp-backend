import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_EMAIL = 'DJ Request App <noreply@easysolution-dp.com>';

interface EmailTemplate {
  to: string;
  subject: string;
  html: string;
}

export class EmailService {
  static async sendDJApprovalEmail(djEmail: string, djName: string): Promise<boolean> {
    try {
      const emailTemplate: EmailTemplate = {
        to: djEmail,
        subject: '🎵 La tua richiesta DJ è stata approvata!',
        html: `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>DJ Request App - Approvazione</title>
              <style>
                body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; 
                  line-height: 1.6; 
                  color: #333; 
                  background-color: #f8f9fa;
                  margin: 0;
                  padding: 0;
                }
                .container { 
                  max-width: 600px; 
                  margin: 0 auto; 
                  background: white; 
                  border-radius: 12px;
                  overflow: hidden;
                  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }
                .header { 
                  background: linear-gradient(135deg, #10b981 0%, #059669 100%); 
                  color: white; 
                  padding: 40px 30px;
                  text-align: center;
                }
                .header h1 { 
                  margin: 0; 
                  font-size: 28px; 
                  font-weight: 700;
                  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                }
                .content { 
                  padding: 40px 30px; 
                }
                .content h2 { 
                  color: #10b981; 
                  margin-top: 0;
                  font-size: 24px;
                  font-weight: 600;
                }
                .content p { 
                  margin-bottom: 20px; 
                  font-size: 16px;
                  line-height: 1.6;
                }
                .cta-button { 
                  display: inline-block; 
                  background: linear-gradient(135deg, #10b981 0%, #059669 100%); 
                  color: white; 
                  padding: 15px 30px; 
                  text-decoration: none; 
                  border-radius: 8px; 
                  font-weight: 600;
                  font-size: 16px;
                  margin: 20px 0;
                  box-shadow: 0 4px 6px rgba(16, 185, 129, 0.3);
                  transition: all 0.3s ease;
                }
                .cta-button:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 6px 12px rgba(16, 185, 129, 0.4);
                }
                .info-box {
                  background: #f0fdf4;
                  border: 2px solid #bbf7d0;
                  border-radius: 8px;
                  padding: 20px;
                  margin: 25px 0;
                }
                .info-box h3 {
                  color: #059669;
                  margin-top: 0;
                  font-size: 18px;
                }
                .footer { 
                  background: #f8f9fa; 
                  padding: 30px; 
                  text-align: center; 
                  color: #6b7280;
                  font-size: 14px;
                  border-top: 1px solid #e5e7eb;
                }
                .alien-icon {
                  font-size: 48px;
                  margin-bottom: 10px;
                  display: block;
                }
                @media (max-width: 600px) {
                  .container { margin: 20px; }
                  .header, .content { padding: 30px 20px; }
                  .cta-button { display: block; text-align: center; }
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <span class="alien-icon">👽🎧</span>
                  <h1>DJ Request App</h1>
                </div>
                <div class="content">
                  <h2>Ciao ${djName}! 🎉</h2>
                  <p>Abbiamo il piacere di informarti che la tua richiesta di registrazione come DJ è stata <strong>approvata</strong>!</p>
                  
                  <div class="info-box">
                    <h3>🚀 Ora puoi iniziare!</h3>
                    <p>Accedi alla tua dashboard DJ per:</p>
                    <ul>
                      <li>Creare eventi musicali</li>
                      <li>Gestire le richieste musicali dei tuoi fan</li>
                      <li>Ricevere donazioni</li>
                      <li>Monitorare le statistiche dei tuoi eventi</li>
                    </ul>
                  </div>

                  <p>Fai clic sul pulsante qui sotto per accedere alla tua dashboard:</p>
                  
                  <a href="${process.env.FRONTEND_URL}/dj/login" class="cta-button">
                    🎵 Accedi alla Dashboard DJ
                  </a>

                  <p><strong>I tuoi dati di accesso:</strong></p>
                  <p>📧 Email: <strong>${djEmail}</strong><br>
                  🔑 Password: quella che hai scelto durante la registrazione</p>

                  <p>Se hai dimenticato la password, potrai cambiarla dalla sezione "Profilo" una volta effettuato l'accesso.</p>

                  <p>Benvenuto nella community di DJ Request App! 🎶</p>
                </div>
                <div class="footer">
                  <p>🎵 DJ Request App - La piattaforma per DJ e fan della musica</p>
                  <p>Questa è una email automatica, non rispondere a questo messaggio.</p>
                  <p>Per supporto, contattaci attraverso l'app.</p>
                </div>
              </div>
            </body>
          </html>
        `
      };

      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: emailTemplate.to,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
      });

      if (error) {
        console.error('Error sending approval email:', error);
        return false;
      }

      console.log(`Approval email sent successfully to ${djEmail}`);
      return true;
    } catch (error) {
      console.error('Error in sendDJApprovalEmail:', error);
      return false;
    }
  }

  static async sendDJRejectionEmail(djEmail: string, djName: string): Promise<boolean> {
    try {
      const emailTemplate: EmailTemplate = {
        to: djEmail,
        subject: 'DJ Request App - Aggiornamento sulla tua richiesta',
        html: `
          <!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>DJ Request App - Aggiornamento</title>
              <style>
                body { 
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; 
                  line-height: 1.6; 
                  color: #333; 
                  background-color: #f8f9fa;
                  margin: 0;
                  padding: 0;
                }
                .container { 
                  max-width: 600px; 
                  margin: 0 auto; 
                  background: white; 
                  border-radius: 12px;
                  overflow: hidden;
                  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                }
                .header { 
                  background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%); 
                  color: white; 
                  padding: 40px 30px;
                  text-align: center;
                }
                .header h1 { 
                  margin: 0; 
                  font-size: 28px; 
                  font-weight: 700;
                  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
                }
                .content { 
                  padding: 40px 30px; 
                }
                .content h2 { 
                  color: #6b7280; 
                  margin-top: 0;
                  font-size: 24px;
                  font-weight: 600;
                }
                .content p { 
                  margin-bottom: 20px; 
                  font-size: 16px;
                  line-height: 1.6;
                }
                .info-box {
                  background: #fef3cd;
                  border: 2px solid #fde68a;
                  border-radius: 8px;
                  padding: 20px;
                  margin: 25px 0;
                }
                .info-box h3 {
                  color: #92400e;
                  margin-top: 0;
                  font-size: 18px;
                }
                .footer { 
                  background: #f8f9fa; 
                  padding: 30px; 
                  text-align: center; 
                  color: #6b7280;
                  font-size: 14px;
                  border-top: 1px solid #e5e7eb;
                }
                .alien-icon {
                  font-size: 48px;
                  margin-bottom: 10px;
                  display: block;
                }
                @media (max-width: 600px) {
                  .container { margin: 20px; }
                  .header, .content { padding: 30px 20px; }
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <span class="alien-icon">👽</span>
                  <h1>DJ Request App</h1>
                </div>
                <div class="content">
                  <h2>Ciao ${djName},</h2>
                  <p>Ti ringraziamo per il tuo interesse nel diventare parte della nostra community di DJ.</p>
                  
                  <div class="info-box">
                    <h3>📝 Aggiornamento sulla tua richiesta</h3>
                    <p>Purtroppo, al momento non possiamo approvare la tua richiesta di registrazione come DJ sulla nostra piattaforma.</p>
                  </div>

                  <p>Questa decisione può essere dovuta a diversi fattori, ma ti incoraggiamo a riprovare in futuro quando le circostanze potrebbero essere cambiate.</p>

                  <p>Ti ringraziamo per la comprensione e speriamo di poterti accogliere nella nostra community in futuro.</p>

                  <p>Un saluto dal team di DJ Request App! 🎶</p>
                </div>
                <div class="footer">
                  <p>🎵 DJ Request App - La piattaforma per DJ e fan della musica</p>
                  <p>Questa è una email automatica, non rispondere a questo messaggio.</p>
                  <p>Per supporto, contattaci attraverso il nostro sito web.</p>
                </div>
              </div>
            </body>
          </html>
        `
      };

      const { error } = await resend.emails.send({
        from: FROM_EMAIL,
        to: emailTemplate.to,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
      });

      if (error) {
        console.error('Error sending rejection email:', error);
        return false;
      }

      console.log(`Rejection email sent successfully to ${djEmail}`);
      return true;
    } catch (error) {
      console.error('Error in sendDJRejectionEmail:', error);
      return false;
    }
  }
}