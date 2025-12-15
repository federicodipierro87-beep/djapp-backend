// @ts-ignore
import paypal from '@paypal/checkout-server-sdk';

const environment = process.env.PAYPAL_MODE === 'live' 
  ? new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID!, process.env.PAYPAL_CLIENT_SECRET!)
  : new paypal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID!, process.env.PAYPAL_CLIENT_SECRET!);

const client = new paypal.core.PayPalHttpClient(environment);

export class PayPalService {
  async createOrder(amount: number, currency: string = 'EUR') {
    try {
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer('return=representation');
      request.requestBody({
        intent: 'AUTHORIZE',
        purchase_units: [{
          amount: {
            currency_code: currency,
            value: amount.toFixed(2)
          },
          description: 'DJ Song Request Donation'
        }],
        application_context: {
          return_url: `${process.env.FRONTEND_URL}/payment/success`,
          cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
          brand_name: 'DJ Request',
          locale: 'en-US',
          user_action: 'PAY_NOW'
        }
      });

      const response = await client.execute(request);
      return response.result;
    } catch (error) {
      console.error('PayPal order creation failed:', error);
      throw error;
    }
  }

  async captureAuthorization(authorizationId: string) {
    try {
      const request = new paypal.payments.AuthorizationsCaptureRequest(authorizationId);
      request.requestBody({});
      
      const response = await client.execute(request);
      return response.result;
    } catch (error) {
      console.error('PayPal authorization capture failed:', error);
      throw error;
    }
  }

  async voidAuthorization(authorizationId: string) {
    try {
      const request = new paypal.payments.AuthorizationsVoidRequest(authorizationId);
      
      const response = await client.execute(request);
      return response.result;
    } catch (error) {
      console.error('PayPal authorization void failed:', error);
      throw error;
    }
  }

  async getOrder(orderId: string) {
    try {
      const request = new paypal.orders.OrdersGetRequest(orderId);
      
      const response = await client.execute(request);
      return response.result;
    } catch (error) {
      console.error('PayPal order retrieval failed:', error);
      throw error;
    }
  }

  async authorizeOrder(orderId: string) {
    try {
      const request = new paypal.orders.OrdersAuthorizeRequest(orderId);
      request.requestBody({});
      
      const response = await client.execute(request);
      return response.result;
    } catch (error) {
      console.error('PayPal order authorization failed:', error);
      throw error;
    }
  }
}

export const paypalService = new PayPalService();