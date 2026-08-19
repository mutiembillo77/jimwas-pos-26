import { PaymentMethod, isProviderActive, isValidPaymentMethod } from '../../types/payment';
import { PaymentProvider } from './PaymentProvider';
import { KCBBuniProvider } from './KCBBuniProvider';
import { NcbaProvider } from './NcbaProvider';
import { CashProvider } from './CashProvider';

/**
 * PaymentProviderFactory
 * Singleton factory mapping each PaymentMethod to its provider implementation.
 */
export class PaymentProviderFactory {
  private static instance: PaymentProviderFactory;
  private providers: Map<PaymentMethod, PaymentProvider>;

  private constructor() {
    this.providers = new Map<PaymentMethod, PaymentProvider>();
    this.providers.set('kcb_buni', new KCBBuniProvider());
    this.providers.set('ncba', new NcbaProvider());
    this.providers.set('cash', new CashProvider());
  }

  public static getInstance(): PaymentProviderFactory {
    if (!PaymentProviderFactory.instance) {
      PaymentProviderFactory.instance = new PaymentProviderFactory();
    }
    return PaymentProviderFactory.instance;
  }

  /**
   * Get the provider instance for the given payment method.
   */
  public getProvider(method: PaymentMethod): PaymentProvider {
    if (!isValidPaymentMethod(method)) {
      throw new Error(`Unsupported or prohibited payment method: ${method}. Allowed methods: kcb_buni, ncba, cash.`);
    }

    const provider = this.providers.get(method);
    if (!provider) {
      throw new Error(`No provider registered for method: ${method}`);
    }

    return provider;
  }

  /**
   * Check if a payment provider is currently active in the ecosystem.
   */
  public isMethodAvailable(method: PaymentMethod): boolean {
    return isValidPaymentMethod(method) && isProviderActive(method);
  }

  /**
   * Register or override a provider implementation (useful for testing or config changes).
   */
  public registerProvider(method: PaymentMethod, provider: PaymentProvider): void {
    this.providers.set(method, provider);
  }
}
