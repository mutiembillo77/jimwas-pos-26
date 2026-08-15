import { Component, useState, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { POSTerminal } from './routes/pos';
import { CustomersPage } from './routes/customers';
import { ProductsPage } from './routes/products';
import { InventoryPage } from './routes/inventory';
import { InstallmentsPage } from './routes/installments';
import { DashboardPage } from './routes/dashboard';
import { LoginPage } from './routes/login';
import { SecurityDashboardPage } from './routes/security';
import { SettingsPage } from './routes/settings';
import { AuditPage } from './routes/audit';
import { TransactionsPage } from './routes/transactions';
import { BackupPage } from './routes/backup';
import { PopulateDBPage } from './routes/populate-db';
import { VoidRequestsPage } from './routes/void-requests';
import { EnterpriseOperationsPage } from './routes/enterprise';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './components/Toast';
import { initNetworkListeners } from './lib/sync';

function AppContent() {
  const [currentPage, setCurrentPage] = useState('pos');
  const { user, isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    try {
      initNetworkListeners();
    } catch (error) {
      console.warn('[v0] Network listener setup skipped:', error);
    }

    // Sync is strictly background work; never hold the first render hostage.
    const syncTimer = setTimeout(() => {
      void import('./lib/sync').then(({ syncNow }) => syncNow()).catch((error) => {
        console.warn('[v0] Background sync skipped:', error);
      });
    }, 5000);

    return () => clearTimeout(syncTimer);
  }, []);

  // Show loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-white">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-400 mx-auto"></div>
          <p className="mt-4 text-slate-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  const renderPage = () => {
    const accessDenied = (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-red-900/20 border border-red-700 rounded-lg p-8 max-w-md">
          <h1 className="text-xl font-bold text-red-400 mb-2">Access Denied</h1>
          <p className="text-red-300">You don&apos;t have permission to access this page.</p>
        </div>
      </div>
    );

    switch (currentPage) {
      case 'pos':
        return <ProtectedRoute routePath="/pos" fallback={accessDenied}><POSTerminal onDeliveryRequested={(transactionId) => { setCurrentPage('outbound-deliveries'); window.dispatchEvent(new CustomEvent('jimwas:open-delivery', { detail: { transactionId } })); }} /></ProtectedRoute>;
      case 'customers':
        return <ProtectedRoute routePath="/customers" fallback={accessDenied}><CustomersPage /></ProtectedRoute>;
      case 'products':
        return <ProtectedRoute routePath="/products" fallback={accessDenied}><ProductsPage /></ProtectedRoute>;
      case 'inventory':
        return <ProtectedRoute routePath="/inventory" fallback={accessDenied}><InventoryPage /></ProtectedRoute>;
      case 'installments':
        return <ProtectedRoute routePath="/installments" fallback={accessDenied}><InstallmentsPage /></ProtectedRoute>;
      case 'dashboard':
        return <ProtectedRoute routePath="/dashboard" fallback={accessDenied}><DashboardPage /></ProtectedRoute>;
      case 'security':
        return <ProtectedRoute routePath="/security" fallback={accessDenied}><SecurityDashboardPage /></ProtectedRoute>;
      case 'settings':
        return <ProtectedRoute routePath="/settings" fallback={accessDenied}><SettingsPage /></ProtectedRoute>;
      case 'audit':
        return <ProtectedRoute routePath="/audit" fallback={accessDenied}><AuditPage /></ProtectedRoute>;
      case 'transactions':
        return <ProtectedRoute routePath="/transactions" fallback={accessDenied}><TransactionsPage /></ProtectedRoute>;
      case 'backup':
        return <ProtectedRoute routePath="/backup" fallback={accessDenied}><BackupPage /></ProtectedRoute>;
      case 'populate-db':
        return <ProtectedRoute routePath="/populate-db" fallback={accessDenied}><PopulateDBPage /></ProtectedRoute>;
      case 'void-requests':
        return <ProtectedRoute routePath="/void-requests" fallback={accessDenied}><VoidRequestsPage /></ProtectedRoute>;
      case 'reports':
        return <ProtectedRoute routePath="/reports" fallback={accessDenied}><EnterpriseOperationsPage section="reports" /></ProtectedRoute>;
      case 'reconciliation':
        return <ProtectedRoute routePath="/reconciliation" fallback={accessDenied}><EnterpriseOperationsPage section="reconciliation" /></ProtectedRoute>;
      case 'outbound-deliveries':
        return <ProtectedRoute routePath="/outbound-deliveries" fallback={accessDenied}><EnterpriseOperationsPage section="deliveries" /></ProtectedRoute>;
      case 'shifts':
        return <ProtectedRoute routePath="/shifts" fallback={accessDenied}><EnterpriseOperationsPage section="shifts" /></ProtectedRoute>;
      case 'offers':
        return <ProtectedRoute routePath="/offers" fallback={accessDenied}><EnterpriseOperationsPage section="offers" /></ProtectedRoute>;
      default:
        return <ProtectedRoute routePath="/pos" fallback={accessDenied}><POSTerminal /></ProtectedRoute>;
    }
  };

  return (
    <Layout currentPage={currentPage} onNavigate={setCurrentPage} user={user}>
      {renderPage()}
    </Layout>
  );
}

type AppErrorBoundaryProps = { children: ReactNode };

type AppErrorBoundaryState = { hasError: boolean; message: string };

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : 'The application could not be loaded.' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[v0] Application render failed:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100"><section className="w-full max-w-lg rounded-xl border border-red-500/30 bg-slate-900 p-6 shadow-xl"><h1 className="text-xl font-semibold">Jimwas POS could not load</h1><p className="mt-2 text-sm text-slate-300">The preview encountered an initialization error. Reload the preview to try again.</p><p className="mt-3 rounded-lg bg-slate-950 p-3 font-mono text-xs text-red-300">{this.state.message}</p><button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white">Reload preview</button></section></main>;
    }
    return this.props.children;
  }
}

function App() {
  return (
    <AppErrorBoundary>
    <AuthProvider>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </AuthProvider>
    </AppErrorBoundary>
  );
}

export default App;
