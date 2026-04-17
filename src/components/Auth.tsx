import React, { useState } from 'react';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut 
} from 'firebase/auth';
import { auth } from '../firebase';
import { motion } from 'motion/react';
import { Mail, Lock, Loader2, AlertCircle, ArrowRight } from 'lucide-react';

interface AuthProps {
  onSuccess: () => void;
}

export const AuthUI: React.FC<AuthProps> = ({ onSuccess }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const validateEmail = (email: string) => {
    return String(email)
      .toLowerCase()
      .match(
        /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
      );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!validateEmail(email)) {
      setError('올바른 이메일을 입력해주세요');
      return;
    }

    if (password.length < 6) {
      setError('비밀번호를 6자 이상 입력해주세요');
      return;
    }

    if (!isLogin && password !== confirmPassword) {
      setError('비밀번호가 일치하지 않습니다');
      return;
    }

    setLoading(true);
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
      onSuccess();
    } catch (err: any) {
      console.error('Auth Error Details:', err);
      if (err.code === 'auth/email-already-in-use') {
        setError('이미 가입된 이메일입니다');
      } else if (err.code === 'auth/operation-not-allowed') {
        setError('이메일/비밀번호 인증이 활성화되지 않았습니다. Firebase 콘솔에서 설정을 확인해주세요.');
      } else if (err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
        setError('이메일 또는 비밀번호를 확인해주세요');
      } else if (err.code === 'auth/network-request-failed') {
        setError('네트워크 연결에 실패했습니다. 인터넷 상태를 확인해주세요.');
      } else {
        setError(`인증 중 오류가 발생했습니다 (${err.code || 'unknown'}). 다시 시도해주세요.`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-[#0a0f1a]">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-10">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="mb-8"
          >
            <img 
              src="/logo.png" 
              alt="Z-ETA Logo" 
              className="w-[120px] h-[120px] mx-auto object-contain drop-shadow-[0_0_20px_rgba(168,85,247,0.4)]"
            />
          </motion.div>
          <h1 className="text-5xl font-black tracking-tighter text-purple-500 mb-2">제때 Z-ETA</h1>
          <p className="text-gray-500 font-medium text-lg">뛸까? 걸을까? 고민은 우리가 할게</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative group">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 group-focus-within:text-purple-500 transition-colors" />
            <input 
              type="email"
              placeholder="이메일"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white placeholder:text-gray-600 focus:outline-none focus:border-purple-500/50 focus:bg-white/[0.08] transition-all"
              required
            />
          </div>

          <div className="relative group">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 group-focus-within:text-purple-500 transition-colors" />
            <input 
              type="password"
              placeholder="비밀번호 (6자 이상)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white placeholder:text-gray-600 focus:outline-none focus:border-purple-500/50 focus:bg-white/[0.08] transition-all"
              required
            />
          </div>

          {!isLogin && (
            <div className="relative group">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 group-focus-within:text-purple-500 transition-colors" />
              <input 
                type="password"
                placeholder="비밀번호 확인"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-white placeholder:text-gray-600 focus:outline-none focus:border-purple-500/50 focus:bg-white/[0.08] transition-all"
                required
              />
            </div>
          )}

          {error && (
            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-center gap-2 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-500 text-xs font-bold"
            >
              <AlertCircle className="w-4 h-4" />
              {error}
            </motion.div>
          )}

          <button 
            type="submit"
            disabled={loading}
            className="w-full py-5 bg-[#a855f7] hover:bg-[#9333ea] active:scale-[0.98] disabled:bg-[#a855f7]/50 text-white rounded-[24px] font-black text-xl shadow-[0_10px_30px_-5px_rgba(168,85,247,0.4)] transition-all flex items-center justify-center gap-3"
          >
            {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : (isLogin ? '로그인' : '회원가입')}
            {!loading && <ArrowRight className="w-6 h-6" />}
          </button>
        </form>

        <div className="mt-8 text-center text-base">
          <button 
            onClick={() => {
              setIsLogin(!isLogin);
              setError('');
            }}
            className="text-gray-500 hover:text-white transition-colors"
          >
            {isLogin ? (
              <>아직 계정이 없으신가요? <span className="text-purple-500 font-bold ml-1">회원가입</span></>
            ) : (
              <>이미 계정이 있으신가요? <span className="text-purple-500 font-bold ml-1">로그인</span></>
            )}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
