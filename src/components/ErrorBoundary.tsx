import React, { ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCcw } from 'lucide-react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      let errorMessage = '오류가 발생했습니다.';
      try {
        const parsed = JSON.parse(this.state.error?.message || '');
        if (parsed.error && parsed.error.includes('permissions')) {
          errorMessage = '데이터 접근 권한이 없습니다. 다시 로그인해 주세요.';
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center p-6">
          <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-[32px] p-8 text-center">
            <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-3xl flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-black text-white mb-4">문제가 발생했습니다</h2>
            <p className="text-gray-400 mb-8 leading-relaxed">
              {errorMessage}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="w-full py-4 bg-white/5 hover:bg-white/10 text-white rounded-2xl font-bold transition-all flex items-center justify-center gap-2"
            >
              <RefreshCcw className="w-5 h-5" />
              다시 시도하기
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
