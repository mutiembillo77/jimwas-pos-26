// Login Page - Authentication form supporting Supabase Auth, email confirmation, and password reset

import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Lock, Mail, Eye, EyeOff, LogIn, AlertCircle, CheckCircle2, ArrowLeft, RefreshCw } from 'lucide-react';

export function LoginPage() {
  const { login, requestPasswordReset, resendConfirmationEmail, isLoading: authLoading } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Email confirmation state
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null);
  const [isResending, setIsResending] = useState(false);

  // Forgot password mode
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [isResetting, setIsResetting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');
    setUnconfirmedEmail(null);
    setIsLoading(true);

    try {
      const result = await login(identifier, password);
      if (!result.success) {
        setError(result.error || 'Login failed');
        if (result.isEmailUnconfirmed && result.unconfirmedEmail) {
          setUnconfirmedEmail(result.unconfirmedEmail);
        }
      }
    } catch {
      setError('An unexpected error occurred during login. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendConfirmation = async () => {
    if (!unconfirmedEmail) return;
    setIsResending(true);
    setError('');
    try {
      const result = await resendConfirmationEmail(unconfirmedEmail);
      if (result.success) {
        setSuccessMessage(`Confirmation email resent to ${unconfirmedEmail}. Please check your inbox.`);
      } else {
        setError(result.error || 'Failed to resend confirmation email.');
      }
    } catch {
      setError('An error occurred while attempting to resend confirmation email.');
    } finally {
      setIsResending(false);
    }
  };

  const handleForgotPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');
    setIsResetting(true);

    try {
      const result = await requestPasswordReset(resetEmail);
      if (result.success) {
        setSuccessMessage(`Password reset link sent to ${resetEmail}. Check your inbox for instructions.`);
      } else {
        setError(result.error || 'Failed to request password reset.');
      }
    } catch {
      setError('An unexpected error occurred while requesting password reset.');
    } finally {
      setIsResetting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-white">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-400 mx-auto"></div>
          <p className="mt-4 text-slate-400">Loading Jimwas POS...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo and Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center mb-3">
            <img src="/logo.svg" alt="Jimwas Enterprises" className="w-24 h-24 mx-auto object-contain drop-shadow-xl" />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Jimwas POS</h1>
          <p className="text-slate-400 mt-2 text-sm">
            {isForgotPassword ? 'Reset your password' : 'Sign in to your account'}
          </p>
        </div>

        {/* Form Container */}
        <div className="bg-slate-800 rounded-xl p-6 shadow-2xl border border-slate-700">
          {error && (
            <div className="flex items-start gap-2.5 p-3.5 bg-red-900/40 border border-red-700/60 rounded-lg text-red-300 text-sm mb-5">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <div className="flex-1">{error}</div>
            </div>
          )}

          {successMessage && (
            <div className="flex items-start gap-2.5 p-3.5 bg-emerald-900/40 border border-emerald-700/60 rounded-lg text-emerald-300 text-sm mb-5">
              <CheckCircle2 size={18} className="shrink-0 mt-0.5" />
              <div className="flex-1">{successMessage}</div>
            </div>
          )}

          {unconfirmedEmail && (
            <div className="p-3.5 bg-amber-900/30 border border-amber-700/50 rounded-lg text-amber-300 text-sm mb-5 space-y-2">
              <p>Email confirmation is pending for <strong>{unconfirmedEmail}</strong>.</p>
              <button
                type="button"
                onClick={handleResendConfirmation}
                disabled={isResending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-medium transition disabled:opacity-50"
              >
                <RefreshCw size={14} className={isResending ? 'animate-spin' : ''} />
                {isResending ? 'Sending...' : 'Resend Confirmation Email'}
              </button>
            </div>
          )}

          {isForgotPassword ? (
            /* Forgot Password Form */
            <form onSubmit={handleForgotPasswordSubmit} className="space-y-5">
              <div>
                <label htmlFor="reset-email" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Account Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    id="reset-email"
                    type="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-700 text-white text-sm rounded-lg border border-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Enter your registered email"
                    required
                    autoFocus
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isResetting}
                className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isResetting ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Sending reset link...
                  </>
                ) : (
                  'Send Reset Link'
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsForgotPassword(false);
                  setError('');
                  setSuccessMessage('');
                }}
                className="w-full py-2 text-slate-400 hover:text-slate-200 text-xs font-medium flex items-center justify-center gap-1.5 transition"
              >
                <ArrowLeft size={14} /> Back to Sign In
              </button>
            </form>
          ) : (
            /* Standard Login Form */
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Identifier Field (Email / Username) */}
              <div>
                <label htmlFor="identifier" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Email or Username
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    id="identifier"
                    type="text"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-slate-700 text-white text-sm rounded-lg border border-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="name@example.com or username"
                    required
                    autoFocus
                  />
                </div>
              </div>

              {/* Password Field */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <label htmlFor="password" className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setIsForgotPassword(true);
                      setResetEmail(identifier.includes('@') ? identifier : '');
                      setError('');
                      setSuccessMessage('');
                    }}
                    className="text-xs text-emerald-400 hover:text-emerald-300 transition"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-10 pr-11 py-2.5 bg-slate-700 text-white text-sm rounded-lg border border-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Enter your password"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-900/20"
              >
                {isLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Signing in...
                  </>
                ) : (
                  <>
                    <LogIn size={18} />
                    Sign In
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-slate-500 text-xs mt-6 font-mono">
          Jimwas POS v2.0 • Secure Enterprise Point of Sale
        </p>
      </div>
    </div>
  );
}

