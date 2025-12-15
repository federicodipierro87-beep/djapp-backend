import crypto from 'crypto';
import axios from 'axios';

const SATISPAY_BASE_URL = process.env.SATISPAY_MODE === 'live' 
  ? 'https://authservices.satispay.com' 
  : 'https://staging.authservices.satispay.com';

export class SatispayService {
  private generateSignature(method: string, path: string, body: string = ''): string {
    const privateKey = process.env.SATISPAY_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('Satispay private key not configured');
    }

    const stringToSign = `${method}|${path}|${body}`;
    const signature = crypto.sign('sha256', Buffer.from(stringToSign), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    });

    return signature.toString('base64');
  }

  async createPayment(amount: number, currency: string = 'EUR', description: string = 'DJ Song Request') {
    try {
      const path = '/g_business/v1/payments';
      const body = JSON.stringify({
        flow: 'MATCH_CODE',
        amount_unit: Math.round(amount * 100),
        currency,
        description
      });

      const signature = this.generateSignature('POST', path, body);

      const response = await axios.post(`${SATISPAY_BASE_URL}${path}`, JSON.parse(body), {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Signature keyId="${process.env.SATISPAY_KEY_ID}", algorithm="rsa-sha256", headers="(request-target) date", signature="${signature}"`,
          'Date': new Date().toISOString()
        }
      });

      return response.data;
    } catch (error) {
      console.error('Satispay payment creation failed:', error);
      throw error;
    }
  }

  async getPayment(paymentId: string) {
    try {
      const path = `/g_business/v1/payments/${paymentId}`;
      const signature = this.generateSignature('GET', path);

      const response = await axios.get(`${SATISPAY_BASE_URL}${path}`, {
        headers: {
          'Authorization': `Signature keyId="${process.env.SATISPAY_KEY_ID}", algorithm="rsa-sha256", headers="(request-target) date", signature="${signature}"`,
          'Date': new Date().toISOString()
        }
      });

      return response.data;
    } catch (error) {
      console.error('Satispay payment retrieval failed:', error);
      throw error;
    }
  }

  async cancelPayment(paymentId: string) {
    try {
      const path = `/g_business/v1/payments/${paymentId}`;
      const body = JSON.stringify({
        action: 'CANCEL'
      });

      const signature = this.generateSignature('PUT', path, body);

      const response = await axios.put(`${SATISPAY_BASE_URL}${path}`, JSON.parse(body), {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Signature keyId="${process.env.SATISPAY_KEY_ID}", algorithm="rsa-sha256", headers="(request-target) date", signature="${signature}"`,
          'Date': new Date().toISOString()
        }
      });

      return response.data;
    } catch (error) {
      console.error('Satispay payment cancellation failed:', error);
      throw error;
    }
  }

  async acceptPayment(paymentId: string) {
    try {
      const path = `/g_business/v1/payments/${paymentId}`;
      const body = JSON.stringify({
        action: 'ACCEPT'
      });

      const signature = this.generateSignature('PUT', path, body);

      const response = await axios.put(`${SATISPAY_BASE_URL}${path}`, JSON.parse(body), {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Signature keyId="${process.env.SATISPAY_KEY_ID}", algorithm="rsa-sha256", headers="(request-target) date", signature="${signature}"`,
          'Date': new Date().toISOString()
        }
      });

      return response.data;
    } catch (error) {
      console.error('Satispay payment acceptance failed:', error);
      throw error;
    }
  }
}

export const satispayService = new SatispayService();