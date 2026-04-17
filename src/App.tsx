/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { AuthUI } from './components/Auth';
import ErrorBoundary from './components/ErrorBoundary';
import { 
  Clock, 
  MapPin, 
  Bus, 
  Train, 
  Footprints, 
  Volume2, 
  VolumeX, 
  ChevronRight, 
  AlertCircle,
  CheckCircle2,
  Timer,
  Calendar,
  XCircle,
  Settings as SettingsIcon,
  ArrowLeft,
  Search,
  Save,
  Loader2,
  ChevronDown,
  X,
  Plus,
  LogOut
} from 'lucide-react';

// --- Types ---
declare global {
  interface Window {
    kakao: any;
  }
}

type CommuteStatus = 'relaxed' | 'warning' | 'danger';
type View = 'home' | 'settings';
type GPSStatus = 'searching' | 'active' | 'error' | 'denied' | 'http';

interface CommuteStep {
  type: 'home' | 'walk' | 'bus' | 'subway' | 'destination';
  label: string;
  duration?: number; // minutes
  lines?: string[]; // Array of bus lines or subway lines
  stationName?: string; // For subway start or single station name
  stationNameEnd?: string; // For subway end
  stationId?: string; // For bus stop ARS-ID
  stationIdEnd?: string; // For bus exit stop ARS-ID
  lat?: number;
  lng?: number;
  isManual?: boolean; // If true, ignore auto-calc
}

interface ScheduleItem {
  day: string;
  time: string;
  enabled: boolean;
  status: 'relaxed' | 'warning' | 'danger' | 'none';
}

interface AppState {
  route: CommuteStep[];
  schedule: ScheduleItem[];
  origin: string;
  destination: string;
}

// --- Constants ---
const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

const MAJOR_STATIONS: Record<string, { lat: number, lng: number }> = {
  '화랑대': { lat: 37.6201, lng: 127.0861 },
  '태릉입구': { lat: 37.6171, lng: 127.0759 },
  '서울역': { lat: 37.5546, lng: 126.9706 },
  '강남': { lat: 37.4979, lng: 127.0276 },
  '신촌': { lat: 37.5552, lng: 126.9368 },
  '이대': { lat: 37.5567, lng: 126.9460 },
  '홍대입구': { lat: 37.5576, lng: 126.9244 },
  '공덕': { lat: 37.5432, lng: 126.9515 },
  '여의도': { lat: 37.5217, lng: 126.9243 },
  '고속터미널': { lat: 37.5045, lng: 127.0044 },
  '잠실': { lat: 37.5133, lng: 127.1001 },
  '사당': { lat: 37.4765, lng: 126.9816 },
  '광화문': { lat: 37.5714, lng: 126.9765 },
};

const DEFAULT_SCHEDULE: ScheduleItem[] = DAYS.map(day => ({
  day,
  time: '09:00',
  enabled: day !== '토' && day !== '일',
  status: 'none'
}));

const DEFAULT_ROUTE: CommuteStep[] = [
  { type: 'home', label: '우리집' },
  { type: 'walk', label: '집에서 버스정류장', duration: 5 },
  { type: 'bus', label: '7017번 정류장', lines: ['7017'], stationId: '08156' },
  { type: 'walk', label: '버스에서 지하철역', duration: 2 },
  { type: 'subway', label: '6호선', lines: ['6'], stationName: '화랑대', stationNameEnd: '공덕' },
  { type: 'walk', label: '지하철에서 학교', duration: 8 },
  { type: 'destination', label: '학교' },
];

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(false);

  const [view, setView] = useState<View>('home');
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [isVoiceInitialized, setIsVoiceInitialized] = useState(false);
  const [commuteStatus, setCommuteStatus] = useState<CommuteStatus>('relaxed');
  const [remainingTime, setRemainingTime] = useState(3); // minutes
  const [upcomingArrivals, setUpcomingArrivals] = useState<any[]>([]);
  const [transferInfo, setTransferInfo] = useState<any>(null);
  const lastStatusRef = useRef<CommuteStatus | null>(null);
  const lastSpokenRef = useRef<string>('');
  const lastPosRef = useRef<{lat: number, lng: number, timestamp: number} | null>(null);

  // GPS & Coaching State
  const [currentSpeed, setCurrentSpeed] = useState(0); // km/h
  const [requiredSpeed, setRequiredSpeed] = useState(0); // km/h
  const [userLocation, setUserLocation] = useState<{lat: number, lng: number} | null>(null);
  const [targetLocation, setTargetLocation] = useState<{lat: number, lng: number, label: string} | null>(null);
  const [distanceToTarget, setDistanceToTarget] = useState<number | null>(null);
  const [coachingMessage, setCoachingMessage] = useState('');
  const [activeLegIndex, setActiveLegIndex] = useState(0);
  const [estArrivalAtSchool, setEstArrivalAtSchool] = useState<string | null>(null);

  // App State
  const [route, setRoute] = useState<CommuteStep[]>(DEFAULT_ROUTE);
  const [schedule, setSchedule] = useState<ScheduleItem[]>(DEFAULT_SCHEDULE);
  const [originAddr, setOriginAddr] = useState('');
  const [destinationAddr, setDestinationAddr] = useState('');

  // Manual Route Builder State
  const [manualSteps, setManualSteps] = useState<CommuteStep[]>(DEFAULT_ROUTE);

  const [gpsStatus, setGpsStatus] = useState<GPSStatus>('searching');
  const [isProtocolSafe, setIsProtocolSafe] = useState(true);

  // --- Auth & Data Fetching ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
      
      if (currentUser) {
        setIsDataLoading(true);
        try {
          const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            if (data.route) setRoute(JSON.parse(data.route));
            if (data.route) setManualSteps(JSON.parse(data.route));
            if (data.schedule) setSchedule(JSON.parse(data.schedule));
            if (data.originAddr) setOriginAddr(data.originAddr);
            if (data.destinationAddr) setDestinationAddr(data.destinationAddr);
            
            // If settings exist, stay in home, else go to settings
            if (!data.originAddr || !data.destinationAddr) {
              setView('settings');
            }
          } else {
            setView('settings');
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, `users/${currentUser.uid}`);
        } finally {
          setIsDataLoading(false);
        }
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setView('home');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const syncToFirestore = async (data: { route: CommuteStep[], schedule: ScheduleItem[], origin: string, destination: string }) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid), {
        email: user.email,
        originAddr: data.origin,
        destinationAddr: data.destination,
        route: JSON.stringify(data.route),
        schedule: JSON.stringify(data.schedule),
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
    }
  };

  // --- Kakao Map Component ---
  const KakaoMap = ({ userLoc, targetLoc, status }: { 
    userLoc: {lat: number, lng: number} | null, 
    targetLoc: {lat: number, lng: number, label: string} | null,
    status: CommuteStatus
  }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstance = useRef<any>(null);
    const userMarker = useRef<any>(null);
    const targetMarker = useRef<any>(null);
    const lineRef = useRef<any>(null);

    useEffect(() => {
      if (!mapRef.current || !window.kakao) return;

      const initMap = () => {
        window.kakao.maps.load(() => {
          if (!mapRef.current) return;
          const options = {
            center: new window.kakao.maps.LatLng(37.5665, 126.9780),
            level: 3
          };
          const map = new window.kakao.maps.Map(mapRef.current, options);
          mapInstance.current = map;
          
          const zoomControl = new window.kakao.maps.ZoomControl();
          map.addControl(zoomControl, window.kakao.maps.ControlPosition.RIGHT);
          
          // Trigger a refresh for markers since map is now ready
          setRoute(prev => [...prev]); 
        });
      };

      if (window.kakao.maps && window.kakao.maps.load) {
        initMap();
      } else {
        // Fallback for script load delay
        const checkInterval = setInterval(() => {
          if (window.kakao && window.kakao.maps && window.kakao.maps.load) {
            clearInterval(checkInterval);
            initMap();
          }
        }, 100);
        return () => clearInterval(checkInterval);
      }

      return () => {
        mapInstance.current = null;
      };
    }, []);

    useEffect(() => {
      const map = mapInstance.current;
      if (!map || (!userLoc && !targetLoc)) return;

      // Update Markers
      if (userLoc) {
        const userPos = new window.kakao.maps.LatLng(userLoc.lat, userLoc.lng);
        if (!userMarker.current) {
          userMarker.current = new window.kakao.maps.Marker({
            position: userPos
          });
          userMarker.current.setMap(map);
        } else {
          userMarker.current.setPosition(userPos);
        }
      }

      if (targetLoc) {
        const targetPos = new window.kakao.maps.LatLng(targetLoc.lat, targetLoc.lng);
        if (!targetMarker.current) {
          targetMarker.current = new window.kakao.maps.Marker({
            position: targetPos,
            title: targetLoc.label
          });
          targetMarker.current.setMap(map);
        } else {
          targetMarker.current.setPosition(targetPos);
        }
      }

      // Update Path (Polyline)
      if (userLoc && targetLoc) {
        const path = [
          new window.kakao.maps.LatLng(userLoc.lat, userLoc.lng),
          new window.kakao.maps.LatLng(targetLoc.lat, targetLoc.lng)
        ];

        if (!lineRef.current) {
          lineRef.current = new window.kakao.maps.Polyline({
            path: path,
            strokeWeight: 4,
            strokeColor: status === 'danger' ? '#f43f5e' : status === 'warning' ? '#f59e0b' : '#10b981',
            strokeOpacity: 0.8,
            strokeStyle: 'solid'
          });
          lineRef.current.setMap(map);
        } else {
          lineRef.current.setPath(path);
          lineRef.current.setOptions({
            strokeColor: status === 'danger' ? '#f43f5e' : status === 'warning' ? '#f59e0b' : '#10b981'
          });
        }
      }

      // Auto Bounds
      const bounds = new window.kakao.maps.LatLngBounds();
      if (userLoc) bounds.extend(new window.kakao.maps.LatLng(userLoc.lat, userLoc.lng));
      if (targetLoc) bounds.extend(new window.kakao.maps.LatLng(targetLoc.lat, targetLoc.lng));
      
      if (userLoc || targetLoc) {
        map.setBounds(bounds, 50, 50, 50, 50); // padding
      }

    }, [userLoc, targetLoc, status]);

    return (
      <div className="relative w-full h-[250px] rounded-3xl overflow-hidden border border-white/5 mb-6 group">
        <div ref={mapRef} className="w-full h-full" />
        
        {/* Speed Overlay on Map */}
        <div className="absolute top-4 left-4 z-10 flex flex-col gap-1 pointer-events-none">
          <div className="bg-black/80 backdrop-blur-md px-4 py-2 rounded-2xl border border-white/10 shadow-xl">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full animate-pulse ${
                status === 'relaxed' ? 'bg-purple-500' : status === 'warning' ? 'bg-amber-500' : 'bg-rose-500'
              }`} />
              <p className="text-2xl font-black font-mono tracking-tighter text-white">
                {currentSpeed.toFixed(1)} <span className="text-[10px] uppercase text-gray-400">km/h</span>
              </p>
            </div>
            <p className="text-[10px] font-bold text-gray-500 mt-0.5 leading-none">
              현재 {currentSpeed.toFixed(1)} <span className="mx-1">→</span> 필요 {requiredSpeed.toFixed(1)} km/h
            </p>
          </div>
        </div>

        {/* GPS Status Indicator */}
        <div className="absolute bottom-4 left-4 z-10 pointer-events-none text-right">
          <div className={`px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border backdrop-blur-sm ${
            gpsStatus === 'active' ? 'bg-purple-500/10 text-purple-500 border-purple-500/20' :
            gpsStatus === 'error' || gpsStatus === 'denied' || gpsStatus === 'http' ? 'bg-red-500/10 text-red-500 border-red-500/20' :
            'bg-blue-500/10 text-blue-500 border-blue-500/20 animate-pulse'
          }`}>
            {gpsStatus === 'active' ? 'GPS 활성' :
             gpsStatus === 'denied' ? 'GPS 권한 차단됨' :
             gpsStatus === 'http' ? '보안 연결(HTTPS) 필요' :
             gpsStatus === 'error' ? 'GPS 오류' : 'GPS 연결 중...'}
          </div>
        </div>
      </div>
    );
  };

  const getDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  const autoCompleteRouteDetails = async (currentManualSteps: CommuteStep[], origin: string, dest: string) => {
    if (!origin || !dest) {
      alert('출발지와 목적지를 모두 입력해주세요.');
      return currentManualSteps;
    }

    try {
      // 1. Get coords for Origin (Address)
      const resOrigin = await fetch(`/api/search-address?query=${encodeURIComponent(origin)}`);
      const dataOrigin = await resOrigin.json();
      const originCoord = dataOrigin.documents?.[0];

      // 2. Get coords for Destination (Keyword)
      const resDest = await fetch(`/api/search-keyword?query=${encodeURIComponent(dest)}`);
      const dataDest = await resDest.json();
      const destCoord = dataDest.documents?.[0];

      if (!originCoord || !destCoord) throw new Error('출발지나 목적지 좌표를 찾을 수 없습니다.');

      // 3. Fetch Full Transit Route
      const routeRes = await fetch(`/api/search-route?sX=${originCoord.x}&sY=${originCoord.y}&sName=${encodeURIComponent(origin)}&eX=${destCoord.x}&eY=${destCoord.y}&eName=${encodeURIComponent(dest)}`);
      if (!routeRes.ok) throw new Error('경로 탐색 API 오류');
      const routeData = await routeRes.json();
      const bestRoute = routeData.routes?.[0];

      if (!bestRoute) {
        alert('추천 경로를 찾을 수 없습니다. 기본 거리 계산으로 전환합니다.');
        // Fallback or abort? Let's just alert for now.
        return currentManualSteps;
      }

      // 4. Match and Sync
      const updatedSteps = [...currentManualSteps];
      const sections = bestRoute.sections;
      let sectionIdx = 0;

      for (let i = 0; i < updatedSteps.length; i++) {
        const step = updatedSteps[i];
        
        // Find matching section in Kakao response
        // This is a heuristic match
        let matchedSection = null;
        if (step.type === 'walk') {
          // Walk sections can be joined if consecutive
          matchedSection = sections.find((s: any, idx: number) => idx >= sectionIdx && s.type === 'WALK' || s.type === 'DISTANCE');
        } else if (step.type === 'bus') {
          matchedSection = sections.find((s: any, idx: number) => idx >= sectionIdx && s.transit?.type === 'BUS');
        } else if (step.type === 'subway') {
          matchedSection = sections.find((s: any, idx: number) => idx >= sectionIdx && s.transit?.type === 'SUBWAY');
        }

        if (matchedSection) {
          // Advance section pointer
          sectionIdx = sections.indexOf(matchedSection) + 1;

          if (step.type === 'walk') {
            const time = Math.round(matchedSection.duration / 60) || 1;
            updatedSteps[i] = { ...step, duration: time, label: `도보 약 ${time}분 (자동계산)` };
          } else if (step.type === 'bus') {
            const transit = matchedSection.transit;
            updatedSteps[i] = { 
              ...step, 
              duration: Math.round(matchedSection.duration / 60),
              lines: step.lines.length > 0 ? step.lines : [transit.name],
              stationId: step.stationId || transit.on_station.ars_id,
              stationIdEnd: transit.off_station.ars_id,
              stationName: transit.on_station.name,
              stationNameEnd: transit.off_station.name,
              lat: parseFloat(transit.on_station.y),
              lng: parseFloat(transit.on_station.x)
            };
          } else if (step.type === 'subway') {
            const transit = matchedSection.transit;
            updatedSteps[i] = { 
              ...step, 
              duration: Math.round(matchedSection.duration / 60),
              lines: step.lines.length > 0 ? step.lines : [transit.name.replace('호선', '')],
              stationName: step.stationName || transit.on_station.name,
              stationNameEnd: transit.off_station.name,
              lat: parseFloat(transit.on_station.y),
              lng: parseFloat(transit.on_station.x)
            };
          }
        }
      }

      return updatedSteps;
    } catch (e: any) {
      console.error(e);
      alert(`자동계산 오류: ${e.message}`);
      return currentManualSteps;
    }
  };

  const addStep = (type: CommuteStep['type']) => {
    const newStep: CommuteStep = {
      type,
      label: type === 'walk' ? '도보 이동' : type === 'bus' ? '버스 승차' : '지하철 승차',
      duration: 10,
      lines: [],
      stationName: '',
      stationNameEnd: '',
      stationId: ''
    };
    setManualSteps([...manualSteps, newStep]);
  };

  const removeStep = (index: number) => {
    setManualSteps(manualSteps.filter((_, i) => i !== index));
  };

  const updateStep = (index: number, updates: Partial<CommuteStep>) => {
    const updated = [...manualSteps];
    updated[index] = { ...updated[index], ...updates };
    setManualSteps(updated);
  };

  // --- Persistence ---
  useEffect(() => {
    if (user) return; // Use Firestore when logged in
    const savedRoute = localStorage.getItem('z-eta-route');
    const savedSchedule = localStorage.getItem('z-eta-schedule');
    const savedOrigin = localStorage.getItem('z-eta-origin');
    const savedDest = localStorage.getItem('z-eta-destination');

    if (savedRoute) {
      const parsed = JSON.parse(savedRoute);
      setRoute(parsed);
      setManualSteps(parsed);
    }
    if (savedSchedule) setSchedule(JSON.parse(savedSchedule));
    if (savedOrigin) setOriginAddr(savedOrigin);
    if (savedDest) setDestinationAddr(savedDest);
  }, []);

  // --- Real-time Clock ---
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- TTS Logic ---
  const speak = useCallback((text: string) => {
    if (!isVoiceEnabled || !isVoiceInitialized) return;
    if (text === lastSpokenRef.current) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
    lastSpokenRef.current = text;
  }, [isVoiceEnabled, isVoiceInitialized]);

  // --- Geolocation Watcher ---
  useEffect(() => {
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
      setIsProtocolSafe(false);
      setGpsStatus('http');
    }

    if (!navigator.geolocation) {
      setGpsStatus('error');
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed } = pos.coords;
        const now = Date.now();
        setGpsStatus('active');
        setUserLocation({ lat: latitude, lng: longitude });
        
        let rawSpeed = (speed !== null && speed !== undefined) ? (speed * 3.6) : 0;

        // Manual Speed Backup (Some devices return null or 0 for speed while walking)
        if (lastPosRef.current) {
          const prev = lastPosRef.current;
          const d = getDistance(prev.lat, prev.lng, latitude, longitude); // meters
          const t = (now - prev.timestamp) / 1000; // seconds
          
          if (t >= 1) {
            // Only update speed if we moved significantly more than typical GPS jitter
            if (d > 1.0) { // More sensitive than before
              const calcSpeed = (d / t) * 3.6;
              // If native speed is 0 or null, use calculated speed
              if (rawSpeed < 0.5) rawSpeed = calcSpeed;
            } else if (t > 4 && d < 0.5) {
              rawSpeed = 0;
            }
          } else if (t < 0.8) {
            return;
          }
        }

        // Apply a smoothing filter
        setCurrentSpeed(prev => {
          if (rawSpeed > 40) return prev;
          return (rawSpeed * 0.4) + (prev * 0.6);
        });
        
        lastPosRef.current = { lat: latitude, lng: longitude, timestamp: now };
      },
      (err) => {
        console.error('GPS Error:', err);
        if (err.code === 1) setGpsStatus('denied');
        else setGpsStatus('error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // --- Coaching Logic ---
  useEffect(() => {
    if (!userLocation || route.length === 0 || remainingTime === undefined) return;

    // Find the next transport leg that hasn't been reached yet
    const transportLegs = route.filter(s => s.type === 'bus' || s.type === 'subway');
    if (transportLegs.length === 0 || activeLegIndex >= transportLegs.length) return;

    if (!targetLocation) return;

    const dist = getDistance(userLocation.lat, userLocation.lng, targetLocation.lat, targetLocation.lng);
    setDistanceToTarget(Math.round(dist));

    // Finish coaching if within 50m
    if (dist < 50) {
      const msg = `${targetLocation.label} 근처에 도착했습니다. 대기 모드로 전환합니다.`;
      setCoachingMessage(msg);
      setRequiredSpeed(0);
      speak(msg);
      
      // If there's a next leg, we could potentially auto-shift after boarding.
      // For now, staying in "waiting" for current leg is fine.
      return;
    }

    if (remainingTime <= 0) {
      const msg = '현재 차량은 탑승이 불가능합니다. 다음 차량을 확인하거나 천천히 이동하세요.';
      setCoachingMessage(msg);
      setRequiredSpeed(0);
      speak(msg);
      return;
    }

    const distKm = dist / 1000;
    const timeHr = remainingTime / 60;
    const reqSpeed = distKm / timeHr;
    setRequiredSpeed(parseFloat(reqSpeed.toFixed(1)));

    let message = '';
    let status: CommuteStatus = 'relaxed';

    if (currentSpeed >= reqSpeed) {
      message = "지금 속도면 여유 있어요. 천천히 걸으세요.";
      status = 'relaxed';
    } else if (reqSpeed <= 6) {
      message = "조금 빠르게 걸으세요. 빠른 걸음이면 탑승 가능합니다.";
      status = 'warning';
    } else if (reqSpeed <= 10) {
      message = "서두르세요! 뛰어야 탑승 가능합니다.";
      status = 'danger';
    } else {
      message = "이번 차량은 놓칠 가능성이 큽니다. 무리하지 말고 다음 차량을 기다리세요.";
      status = 'danger';
    }

    setCoachingMessage(message);
    setCommuteStatus(status);
    
    // Only announce if the minutes remaining or status message changed
    const ttsText = `교통수단 ${remainingTime}분 뒤 도착. ${message}`;
    speak(ttsText);

  }, [userLocation, targetLocation, remainingTime, currentSpeed, speak, route]);

  // --- Real-time Transportation Data ---
  const fetchRealtimeData = useCallback(async () => {
    if (!route || route.length === 0) return;

    // Find the first transport leg (Bus/Subway)
    const transportLegs = route.filter(s => s.type === 'bus' || s.type === 'subway');
    if (transportLegs.length === 0) return;

    // Use current active leg for coaching
    const currentActiveIdx = Math.min(activeLegIndex, transportLegs.length - 1);
    const firstLeg = transportLegs[currentActiveIdx];
    
    // Auto-detect if we arrived at firstLeg and should shift to secondLeg
    if (userLocation && firstLeg.lat && firstLeg.lng) {
      const dist = getDistance(userLocation.lat, userLocation.lng, firstLeg.lat, firstLeg.lng);
      // If we were close and now we are moving away significantly (e.g. onboard), shift?
      // Simplified: If user hits 50m radius, keep it as current. 
      // User can manually shift or we shift when first leg arrival time passes.
    }
    
    // Also try to find the target location for coaching
    // The target is the first transport leg station
    if (firstLeg.lat && firstLeg.lng) {
      setTargetLocation({ lat: firstLeg.lat, lng: firstLeg.lng, label: firstLeg.label });
    } else if (firstLeg.type === 'subway' && firstLeg.stationName && MAJOR_STATIONS[firstLeg.stationName.replace('역', '')]) {
      const coords = MAJOR_STATIONS[firstLeg.stationName.replace('역', '')];
      setTargetLocation({ ...coords, label: firstLeg.label });
    } else {
      // Fallback: Fetch coordinates if missing
      try {
        if (firstLeg.type === 'subway' && firstLeg.stationName) {
          const sRes = await fetch(`/api/subway-station?station=${encodeURIComponent(firstLeg.stationName)}`);
          const sData = await sRes.json();
          if (sData.x) setTargetLocation({ lat: parseFloat(sData.y), lng: parseFloat(sData.x), label: firstLeg.label });
        } else if (firstLeg.type === 'bus' && firstLeg.stationId) {
          const bRes = await fetch(`/api/bus?arsId=${firstLeg.stationId}`);
          const bData = await bRes.json();
          const bItem = bData[0];
          if (bItem?.tmX) setTargetLocation({ lat: parseFloat(bItem.tmY), lng: parseFloat(bItem.tmX), label: firstLeg.label });
        }
      } catch (e) { console.error('Target fetch error:', e); }
    }
    const secondLeg = transportLegs.length > 1 ? transportLegs[1] : null;

    try {
      // 1. Fetch First Leg
      let firstArrivals: any[] = [];
      if (firstLeg.type === 'subway' && firstLeg.stationName) {
        const stationName = firstLeg.stationName.replace('역', '');
        const res = await fetch(`/api/subway?station=${encodeURIComponent(stationName)}`);
        if (!res.ok) throw new Error(`Subway API status: ${res.status}`);
        const data = await res.json();
        
        // If lines filter is set, try to filter
        firstArrivals = (data.realtimeArrivalList || []).map((item: any) => ({
          time: Math.round(parseInt(item.barvlDt) / 60), // minutes
          line: item.trainLineNm,
          type: 'subway'
        })).filter((a: any) => {
          if (!firstLeg.lines || firstLeg.lines.length === 0) return true;
          // Filter if item label contains any of our lines
          return firstLeg.lines.some(l => a.line.includes(l));
        }).filter((a: any) => a.time > 0).sort((a: any, b: any) => a.time - b.time);
      } else if (firstLeg.type === 'bus' && firstLeg.stationId) {
        // Fetch all info for station, filter by lines
        const busLines = firstLeg.lines || [];
        const res = await fetch(`/api/bus?arsId=${firstLeg.stationId}`);
        if (!res.ok) throw new Error(`Bus API status: ${res.status}`);
        const data = await res.json();
        firstArrivals = data.flatMap((item: any) => {
          // Check if this bus is in our lines
          if (busLines.length > 0 && !busLines.includes(String(item.rtNm))) return [];

          const parseTime = (msg: string) => {
            if (msg.includes('곧 도착')) return 1;
            if (msg.includes('운행종료')) return 999;
            const m = msg.match(/\d+분/);
            return m ? parseInt(m[0]) : 999;
          };
          
          const times = [];
          times.push({ time: parseTime(item.arrmsg1), line: item.rtNm, type: 'bus' });
          times.push({ time: parseTime(item.arrmsg2), line: item.rtNm, type: 'bus' });
          return times;
        }).filter((a: any) => a.time < 999).sort((a: any, b: any) => a.time - b.time);
      }

      // Calculate Goal-based Risk and Update ETA
      if (firstArrivals.length > 0) {
        setRemainingTime(firstArrivals[0].time);
        
        const todayWeekday = formattedDate.split(' ').pop()?.charAt(0) || ''; // Get '금' from '금요일'
        const todaySchedule = schedule.find(s => s.day === todayWeekday);
        
        if (todaySchedule && todaySchedule.enabled) {
          const [goalH, goalM] = todaySchedule.time.split(':').map(Number);
          const goalDate = new Date();
          goalDate.setHours(goalH, goalM, 0, 0);

          // Sum up subsequent leg durations
          const transportStepIdx = route.indexOf(firstLeg);
          let remainingDurationFromBoarding = (firstLeg.duration || 0); 
          for (let j = transportStepIdx + 1; j < route.length; j++) {
            remainingDurationFromBoarding += (route[j].duration || 0);
          }

          const calculateArrival = (arrivalMin: number) => {
            return new Date(Date.now() + (arrivalMin + remainingDurationFromBoarding) * 60000);
          };

          const firstETA = calculateArrival(firstArrivals[0].time);
          const secondETA = firstArrivals.length > 1 ? calculateArrival(firstArrivals[1].time) : null;

          setEstArrivalAtSchool(firstETA.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }));

          if (firstETA > goalDate) {
            setCommuteStatus('danger');
          } else if (secondETA && secondETA > goalDate) {
            setCommuteStatus('warning');
          } else {
            setCommuteStatus('relaxed');
          }
        }
      }
      setUpcomingArrivals(firstArrivals);

      // 2. Fetch Second Leg (Transfer)
      if (secondLeg) {
        if (secondLeg.type === 'subway' && secondLeg.stationName) {
          const res = await fetch(`/api/subway?station=${encodeURIComponent(secondLeg.stationName.replace('역', ''))}`);
          const data = await res.json();
          const transfer = (data.realtimeArrivalList || []).find((item: any) => {
            if (!secondLeg.lines || secondLeg.lines.length === 0) return true;
            return secondLeg.lines.some(l => item.trainLineNm.includes(l));
          });
          if (transfer) {
            setTransferInfo({
              line: secondLeg.lines?.[0] || '지상철',
              time: Math.round(parseInt(transfer.barvlDt) / 60),
              dest: transfer.trainLineNm
            });
          }
        }
      }

      // 3. Cleanup redundant calls
    } catch (error) {
      console.error('Failed to fetch realtime data:', error);
    }
  }, [route]);

  useEffect(() => {
    fetchRealtimeData();
    const interval = setInterval(fetchRealtimeData, 30000); // 30s
    return () => clearInterval(interval);
  }, [fetchRealtimeData, activeLegIndex]);

  useEffect(() => {
    // We already have a coaching logic trigger with TTS
  }, []);

  const handleInitializeVoice = () => {
    setIsVoiceInitialized(true);
    const utterance = new SpeechSynthesisUtterance("음성 안내를 시작합니다. 제때와 함께 안전한 출근길 되세요.");
    utterance.lang = 'ko-KR';
    window.speechSynthesis.speak(utterance);
  };

  // --- UI Helpers ---
  const getStatusColor = (status: CommuteStatus) => {
    switch (status) {
      case 'relaxed': return '#10b981'; // Emerald 500
      case 'warning': return '#f59e0b'; // Amber 500
      case 'danger': return '#f43f5e';  // Rose 500
      default: return '#22c55e';
    }
  };

  const formattedDate = currentTime.toLocaleDateString('ko-KR', { 
    month: 'long', 
    day: 'numeric', 
    weekday: 'long' 
  });
  
  const formattedTime = currentTime.toLocaleTimeString('ko-KR', { 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit',
    hour12: false 
  });

  const getStepIcon = (step: CommuteStep) => {
    switch (step.type) {
      case 'home': return <MapPin className="w-4 h-4" />;
      case 'walk': return <Footprints className="w-4 h-4" />;
      case 'bus': return <Bus className="w-4 h-4" />;
      case 'subway': return <Train className="w-4 h-4" />;
      case 'destination': return <MapPin className="w-4 h-4" />;
      default: return <MapPin className="w-4 h-4" />;
    }
  };

  if (isAuthLoading || isDataLoading) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-purple-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <AuthUI onSuccess={() => {}} />;
  }

  if (view === 'settings') {
    return (
      <Settings 
        onBack={() => setView('home')} 
        onSave={async (data) => {
          setRoute(data.route);
          setSchedule(data.schedule);
          setOriginAddr(data.origin);
          setDestinationAddr(data.destination);
          
          if (user) {
            await syncToFirestore(data);
          } else {
            localStorage.setItem('z-eta-route', JSON.stringify(data.route));
            localStorage.setItem('z-eta-schedule', JSON.stringify(data.schedule));
            localStorage.setItem('z-eta-origin', data.origin);
            localStorage.setItem('z-eta-destination', data.destination);
          }
          setView('home');
        }}
        initialSchedule={schedule}
        initialOrigin={originAddr}
        initialDestination={destinationAddr}
        manualSteps={manualSteps}
        addStep={addStep}
        removeStep={removeStep}
        updateStep={updateStep}
        onAutoCalc={async (origin, dest) => {
          const updated = await autoCompleteRouteDetails(manualSteps, origin, dest);
          setManualSteps(updated);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white font-sans selection:bg-purple-500/30">
      <div className="max-w-md mx-auto px-6 py-8 pb-24">
        
        {/* Header: Time & Voice Toggle */}
        <header className="flex justify-between items-start mb-6">
          <div>
            <p className="text-gray-400 text-sm font-medium mb-1">{formattedDate}</p>
            <h1 className="text-4xl font-bold tracking-tighter font-mono">{formattedTime}</h1>
          </div>
          <div className="flex flex-col gap-2 items-end">
            <div className="flex gap-2">
              <button 
                onClick={() => setView('settings')}
                className="p-3 rounded-2xl bg-white/5 text-gray-400 hover:text-white transition-colors"
                title="설정"
              >
                <SettingsIcon className="w-6 h-6" />
              </button>
              <button 
                onClick={() => setIsVoiceEnabled(!isVoiceEnabled)}
                className={`p-3 rounded-2xl transition-all duration-300 ${
                isVoiceEnabled ? 'bg-purple-500/10 text-purple-500' : 'bg-white/5 text-gray-500'
              }`}
                title="음성 안내"
              >
                {isVoiceEnabled ? <Volume2 className="w-6 h-6" /> : <VolumeX className="w-6 h-6" />}
              </button>
            </div>
            <button 
              onClick={handleLogout}
              className="px-4 py-2 rounded-xl bg-white/5 text-[10px] font-bold text-gray-500 hover:text-red-400 transition-colors flex items-center gap-1.5"
            >
              <LogOut className="w-3 h-3" />
              로그아웃
            </button>
          </div>
        </header>

        {/* GPS Blockers */}
        {!isProtocolSafe && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-500 text-xs font-bold flex items-center gap-3">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p>보안 연결(HTTPS)이 아닙니다. GPS 기능을 위해 HTTPS로 접속해 주세요.</p>
          </div>
        )}
        {gpsStatus === 'denied' && (
          <div className="mb-6 p-4 bg-orange-500/10 border border-orange-500/20 rounded-2xl text-orange-500 text-xs font-bold flex items-center gap-3">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p>위치 권한이 거부되었습니다. 설정에서 위치 권한을 허용해 주세요.</p>
          </div>
        )}

        {/* Map View */}
        <KakaoMap 
          userLoc={userLocation} 
          targetLoc={targetLocation} 
          status={commuteStatus} 
        />

        {/* Voice Initialization Overlay */}
        {!isVoiceInitialized && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#0a0f1a]/80 backdrop-blur-sm px-6"
          >
            <button 
              onClick={handleInitializeVoice}
              className="w-full max-w-xs bg-purple-500 hover:bg-purple-600 text-black font-bold py-5 rounded-[24px] shadow-lg shadow-purple-500/20 transition-transform active:scale-95 flex items-center justify-center gap-3"
            >
              <Volume2 className="w-6 h-6" />
              음성 안내 시작하기
            </button>
          </motion.div>
        )}

        {/* Main Status Card */}
        <motion.section 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative overflow-hidden bg-white/[0.04] border border-white/[0.08] rounded-[32px] p-8 mb-8"
        >
          <div 
            className="absolute -top-24 -right-24 w-48 h-48 blur-[80px] opacity-20 rounded-full transition-colors duration-1000"
            style={{ backgroundColor: getStatusColor(commuteStatus) }}
          />

          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-4">
              <span 
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: getStatusColor(commuteStatus) }}
              />
              <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
                {commuteStatus === 'relaxed' ? '여유로운 상태' : 
                 commuteStatus === 'warning' ? '서둘러야 함' : '지각 위험'}
              </span>
            </div>

            <div className="flex flex-col mb-8">
              <span className="text-sm text-gray-400 mb-1">다음 교통수단 도착까지</span>
              <div className="flex items-baseline gap-2">
                <span className="text-7xl font-black tracking-tighter" style={{ color: getStatusColor(commuteStatus) }}>
                  {remainingTime}
                </span>
                <span className="text-2xl font-bold text-gray-300">분</span>
              </div>
              {upcomingArrivals.length > 1 && (
                <div className="mt-2 flex gap-3 overflow-x-auto no-scrollbar py-1">
                  {upcomingArrivals.slice(1, 3).map((a, i) => (
                    <div key={i} className="flex items-center gap-1 bg-white/5 px-2 py-1 rounded-lg">
                      <Clock className="w-3 h-3 text-gray-500" />
                      <span className="text-xs font-bold text-gray-300">다음 {a.time}분</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white/[0.03] rounded-2xl p-4 border border-white/[0.05]">
                <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">학교 도착 예정</p>
                <div className="flex items-center gap-2">
                  <p className="text-xl font-black text-white">{estArrivalAtSchool || '--:--'}</p>
                </div>
              </div>
              <div className="bg-white/[0.03] rounded-2xl p-4 border border-white/[0.05]">
                <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">현재 상태</p>
                <p className="text-lg font-bold flex items-center gap-1" style={{ color: getStatusColor(commuteStatus) }}>
                  {commuteStatus === 'relaxed' ? (
                    <><CheckCircle2 className="w-4 h-4" />여유</>
                  ) : commuteStatus === 'warning' ? (
                    <><AlertCircle className="w-4 h-4" />이번 필수</>
                  ) : (
                    <><XCircle className="w-4 h-4" />지각 위험</>
                  )}
                </p>
              </div>
            </div>

            {/* GPS Speed Coaching UI (Deprecated legacy view, replaced by map overlay) */}
            <div className="mt-6 pt-6 border-t border-white/5">
              <div className="p-4 bg-white/[0.02] border border-white/5 rounded-2xl">
                <div className="flex items-start gap-3">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                    commuteStatus === 'relaxed' ? 'bg-purple-500/10 text-purple-500' :
                    commuteStatus === 'warning' ? 'bg-orange-500/10 text-orange-500' :
                    'bg-red-500/10 text-red-500'
                  }`}>
                    <Timer className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-bold leading-relaxed">
                      {!userLocation 
                        ? 'GPS 신호를 찾는 중입니다... 넓은 곳으로 이동해 주세요.' 
                        : (coachingMessage || '경로를 확인하고 이동을 시작하세요.')}
                    </p>
                    {distanceToTarget !== null && userLocation && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                        <p className="text-[10px] text-gray-500 font-medium italic">
                          {targetLocation?.label || '목적지'}까지 {distanceToTarget}m 남음
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Leg Navigation */}
                {route.filter(s => s.type === 'bus' || s.type === 'subway').length > 1 && (
                  <div className="mt-4 flex gap-2">
                    <button 
                      onClick={() => setActiveLegIndex(Math.max(0, activeLegIndex - 1))}
                      disabled={activeLegIndex === 0}
                      className="flex-1 py-2 bg-white/5 disabled:opacity-30 rounded-xl text-[10px] font-bold uppercase transition-colors"
                    >
                      이전 단계
                    </button>
                    <button 
                      onClick={() => setActiveLegIndex(Math.min(route.filter(s => s.type === 'bus' || s.type === 'subway').length - 1, activeLegIndex + 1))}
                      disabled={activeLegIndex >= route.filter(s => s.type === 'bus' || s.type === 'subway').length - 1}
                      className="flex-1 py-2 bg-purple-500/10 text-purple-500 disabled:opacity-30 rounded-xl text-[10px] font-bold uppercase transition-colors"
                    >
                      다음 단계 (환승)
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </motion.section>

        {/* Route Summary */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4 px-2">
            <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">이동 경로 요약</h2>
            <button className="text-xs text-purple-500 font-medium">상세보기</button>
          </div>
          
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-[24px] p-5">
            <div className="flex items-center flex-wrap gap-y-4">
              {route.map((step, idx) => (
                <div key={idx} className="flex items-center">
                  <div className={`flex flex-col items-center gap-1 ${idx === 0 || idx === route.length - 1 ? 'px-1' : ''}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      step.type === 'bus' ? 'bg-blue-500/20 text-blue-400' :
                      step.type === 'subway' ? 'bg-purple-500/20 text-purple-400' :
                      'bg-white/10 text-gray-400'
                    }`}>
                      {getStepIcon(step)}
                    </div>
                    <span className="text-[10px] font-medium text-gray-500 text-center max-w-[50px] truncate">
                      {step.type === 'bus' ? step.lines?.join(',') : 
                       step.type === 'subway' ? `${step.stationName}→${step.stationNameEnd}` : 
                       step.label}
                    </span>
                  </div>
                  {idx < route.length - 1 && (
                    <ChevronRight className="w-4 h-4 text-gray-700 mx-1" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Transfer Info (Conditional) */}
        {transferInfo && (
          <section className="mb-10">
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-[24px] p-6 flex items-center gap-5">
              <div className="w-12 h-12 rounded-2xl bg-purple-500/10 flex items-center justify-center text-purple-500">
                <Train className="w-6 h-6" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-gray-500 font-medium mb-1">환승 예정: {transferInfo.line}</p>
                <p className="text-sm font-bold">{transferInfo.dest} {transferInfo.time}분 뒤 도착</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-gray-500 uppercase tracking-tighter">예상 페이스</p>
                <p className="text-sm font-mono font-bold">정상</p>
              </div>
            </div>
          </section>
        )}

        {/* Weekly Schedule */}
        <section>
          <div className="flex items-center gap-2 mb-4 px-2">
            <Calendar className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">이번 주 시간표</h2>
          </div>
          
          <div className="grid grid-cols-7 gap-2">
            {schedule.map((item, idx) => (
              <div 
                key={idx} 
                className={`flex flex-col items-center py-3 rounded-2xl border ${
                  item.day === formattedDate.split(' ')[2] ? 'bg-purple-500/10 border-purple-500/30' : 'bg-white/[0.02] border-white/[0.05]'
                }`}
              >
                <span className="text-[10px] font-bold text-gray-500 mb-2">{item.day}</span>
                <span className={`text-[11px] font-mono font-bold ${
                  !item.enabled ? 'text-gray-700' :
                  item.status === 'danger' ? 'text-red-500' : 
                  item.status === 'warning' ? 'text-orange-500' : 
                  item.status === 'relaxed' ? 'text-purple-500' : 'text-gray-400'
                }`}>
                  {item.enabled ? item.time : '-'}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Bottom Simulation Controls */}
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex gap-2 bg-black/40 backdrop-blur-md p-2 rounded-full border border-white/10">
          <button 
            onClick={() => { setCommuteStatus('relaxed'); setRemainingTime(5); }}
            className="px-3 py-1 text-[10px] font-bold rounded-full bg-purple-500/20 text-purple-500"
          >
            여유
          </button>
          <button 
            onClick={() => { setCommuteStatus('warning'); setRemainingTime(2); }}
            className="px-3 py-1 text-[10px] font-bold rounded-full bg-orange-500/20 text-orange-500"
          >
            경고
          </button>
          <button 
            onClick={() => { setCommuteStatus('danger'); setRemainingTime(1); }}
            className="px-3 py-1 text-[10px] font-bold rounded-full bg-red-500/20 text-red-500"
          >
            위험
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Settings Component ---
interface SettingsProps {
  onBack: () => void;
  onSave: (data: { route: CommuteStep[], schedule: ScheduleItem[], origin: string, destination: string }) => void;
  initialSchedule: ScheduleItem[];
  initialOrigin: string;
  initialDestination: string;
  manualSteps: CommuteStep[];
  addStep: (type: CommuteStep['type']) => void;
  removeStep: (index: number) => void;
  updateStep: (index: number, updates: Partial<CommuteStep>) => void;
  onAutoCalc: (origin: string, dest: string) => Promise<void>;
}

function Settings({ 
  onBack, onSave, initialSchedule, initialOrigin, initialDestination, 
  manualSteps, addStep, removeStep, updateStep, onAutoCalc 
}: SettingsProps) {
  const [schedule, setSchedule] = useState<ScheduleItem[]>(initialSchedule);
  const [origin, setOrigin] = useState(initialOrigin);
  const [destination, setDestination] = useState(initialDestination);
  const [isCalcLoading, setIsCalcLoading] = useState(false);

  const totalDuration = manualSteps.reduce((acc, s) => acc + (s.duration || 0), 0);
  const currentDay = new Date().toLocaleDateString('ko-KR', { weekday: 'long' }).split(' ')[0][0];
  const todaySchedule = schedule.find(s => s.day === currentDay);
  
  const getDepartureRecommendation = () => {
    if (!todaySchedule || !todaySchedule.enabled) return null;
    const [h, m] = todaySchedule.time.split(':').map(Number);
    const goal = new Date();
    goal.setHours(h, m, 0);
    const departure = new Date(goal.getTime() - totalDuration * 60000);
    return departure.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const handleSave = () => {
    onSave({
      route: manualSteps,
      schedule,
      origin,
      destination
    });
  };

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white font-sans">
      <div className="max-w-md mx-auto px-6 py-8">
        <header className="flex items-center gap-4 mb-8">
          <button onClick={onBack} className="p-2 -ml-2 text-gray-400 hover:text-white">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h1 className="text-xl font-bold">나의 등교 경로 설정</h1>
        </header>

        {/* Global Addresses */}
        <section className="space-y-4 mb-10">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold ml-1">우리 집 주소</label>
            <div className="relative">
              <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input 
                type="text" 
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="예: 서울특별시 노원구..."
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-2xl py-4 pl-11 pr-4 focus:outline-none focus:border-purple-500/50 transition-colors text-sm"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold ml-1">목적지 (학교/교실)</label>
            <div className="relative">
              <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input 
                type="text" 
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="예: 이화여자대학교 대강당"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-2xl py-4 pl-11 pr-4 focus:outline-none focus:border-purple-500/50 transition-colors text-sm"
              />
            </div>
          </div>
        </section>

        {/* Manual Route Builder */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4 px-1">
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">이동 단계 구성</h2>
            <div className="flex gap-2">
              <button 
                onClick={async () => {
                  setIsCalcLoading(true);
                  await onAutoCalc(origin, destination);
                  setIsCalcLoading(false);
                }}
                disabled={isCalcLoading}
                className="p-2 bg-purple-500/10 rounded-xl text-[10px] font-bold text-purple-500 hover:bg-purple-500/20 border border-purple-500/30 flex items-center gap-1"
              >
                {isCalcLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Timer className="w-3 h-3" />}
                경로상세 자동완성
              </button>
              <button onClick={() => addStep('walk')} className="p-2 bg-white/5 rounded-xl text-[10px] font-bold hover:bg-white/10 border border-white/5">+ 도보</button>
              <button onClick={() => addStep('bus')} className="p-2 bg-blue-500/20 rounded-xl text-[10px] font-bold text-blue-400 hover:bg-blue-500/30 border border-blue-500/20">+ 버스</button>
              <button onClick={() => addStep('subway')} className="p-2 bg-purple-500/20 rounded-xl text-[10px] font-bold text-purple-400 hover:bg-purple-500/30 border border-purple-500/20">+ 지하철</button>
            </div>
          </div>

          <div className="space-y-3">
            {manualSteps.length === 0 && (
              <div className="py-10 text-center border-2 border-dashed border-white/5 rounded-3xl">
                <p className="text-sm text-gray-600">등록된 단계가 없습니다.<br/>위의 버튼을 눌러 경로를 만드세요.</p>
              </div>
            )}
            {manualSteps.map((step, idx) => (
              <div key={idx} className="bg-white/[0.03] border border-white/[0.08] rounded-3xl p-4 relative group">
                <button 
                  onClick={() => removeStep(idx)}
                  className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                >
                  <X className="w-3 h-3 text-white" />
                </button>

                <div className="flex items-start gap-4">
                  <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
                    step.type === 'bus' ? 'bg-blue-500/10 text-blue-400' :
                    step.type === 'subway' ? 'bg-purple-500/10 text-purple-400' :
                    'bg-white/5 text-gray-500'
                  }`}>
                    {step.type === 'bus' ? <Bus className="w-5 h-5" /> : 
                     step.type === 'subway' ? <Train className="w-5 h-5" /> : 
                     <Footprints className="w-5 h-5" />}
                  </div>

                  <div className="flex-1 space-y-3 min-w-0">
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={step.label}
                        onChange={(e) => updateStep(idx, { label: e.target.value })}
                        placeholder="이름 (예: 7017번 버스)"
                        className="flex-1 bg-white/5 border border-white/5 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-white/20 min-w-0"
                      />
                      <div className="flex items-center gap-2 shrink-0">
                        {step.type === 'walk' && !step.isManual ? (
                          <div className="flex flex-col items-end">
                            <span className="text-[10px] font-bold text-purple-500 whitespace-nowrap">자동계산 중</span>
                            <button 
                              onClick={() => updateStep(idx, { isManual: true })}
                              className="text-[8px] text-gray-500 underline"
                            >
                              수동 수정
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center bg-white/5 border border-white/5 rounded-xl px-3">
                            <input 
                              type="number" 
                              value={step.duration}
                              onChange={(e) => updateStep(idx, { duration: parseInt(e.target.value) || 0, isManual: step.type === 'walk' })}
                              className="w-8 bg-transparent text-center text-xs font-mono font-bold focus:outline-none"
                            />
                            <span className="text-[10px] text-gray-500 font-bold ml-1">분</span>
                            {step.type === 'walk' && step.isManual && (
                              <button 
                                onClick={() => updateStep(idx, { isManual: false })}
                                className="ml-2 text-[8px] text-blue-500 underline"
                              >
                                자동복구
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {(step.type === 'bus' || step.type === 'subway') && (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <label className="text-[9px] text-gray-600 font-bold ml-1 uppercase">{step.type === 'bus' ? '정류소 번호' : '호선'}</label>
                            <input 
                              type="text" 
                              value={step.type === 'bus' ? (step.stationId || '') : (step.lines?.[0] || '')}
                              onChange={(e) => updateStep(idx, step.type === 'bus' ? { stationId: e.target.value } : { lines: [e.target.value] })}
                              placeholder={step.type === 'bus' ? "08156" : "6"}
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs focus:outline-none"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[9px] text-gray-600 font-bold ml-1 uppercase">{step.type === 'bus' ? '버스 번호 (쉼표로 구분)' : '출발역'}</label>
                            <input 
                              type="text" 
                              value={step.type === 'bus' ? (step.lines?.join(', ') || '') : (step.stationName || '')}
                              onChange={(e) => {
                                if (step.type === 'bus') {
                                  updateStep(idx, { lines: e.target.value.split(',').map(s => s.trim()).filter(s => s) });
                                } else {
                                  updateStep(idx, { stationName: e.target.value });
                                }
                              }}
                              placeholder={step.type === 'bus' ? "7017, 272" : "화랑대"}
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs focus:outline-none"
                            />
                          </div>
                        </div>
                        {step.type === 'subway' && (
                          <div className="space-y-1">
                            <label className="text-[9px] text-gray-600 font-bold ml-1 uppercase">도착역</label>
                            <input 
                              type="text" 
                              value={step.stationNameEnd || ''}
                              onChange={(e) => updateStep(idx, { stationNameEnd: e.target.value })}
                              placeholder="이대역"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs focus:outline-none"
                            />
                          </div>
                        )}
                        {step.type === 'bus' && (
                          <div className="space-y-1">
                            <label className="text-[9px] text-gray-600 font-bold ml-1 uppercase">하차 정류소 번호 (ARS-ID, 선택사항)</label>
                            <input 
                              type="text" 
                              value={step.stationIdEnd || ''}
                              onChange={(e) => updateStep(idx, { stationIdEnd: e.target.value })}
                              placeholder="08157"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs focus:outline-none"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Weekly Schedule */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4 px-1">
            <Calendar className="w-4 h-4 text-gray-500" />
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-widest">등교 시간 설정</h2>
          </div>
          <div className="bg-white/[0.03] border border-white/[0.08] rounded-3xl p-5 space-y-4">
            {schedule.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button 
                    onClick={() => {
                      const updated = [...schedule];
                      updated[idx].enabled = !updated[idx].enabled;
                      setSchedule(updated);
                    }}
                    className={`w-10 py-1 rounded-lg text-[10px] font-bold border transition-all ${
                      item.enabled ? 'bg-purple-500/10 border-purple-500/30 text-purple-500' : 'bg-white/5 border-white/10 text-gray-600'
                    }`}
                  >
                    {item.day}
                  </button>
                  {item.enabled && (
                    <input 
                      type="time" 
                      value={item.time}
                      onChange={(e) => {
                        const updated = [...schedule];
                        updated[idx].time = e.target.value;
                        setSchedule(updated);
                      }}
                      className="bg-transparent text-sm font-mono font-bold focus:outline-none"
                    />
                  )}
                </div>
                {!item.enabled && <span className="text-[10px] text-gray-700 font-bold">휴무/공강</span>}
              </div>
            ))}
          </div>
        </section>

        {/* Route Summary Stats */}
        <section className="mb-10 bg-white/[0.04] border border-white/[0.08] rounded-3xl p-6">
          <div className="flex justify-between items-center mb-4">
            <span className="text-xs text-gray-500 font-bold uppercase tracking-widest">총 예상 소요시간</span>
            <span className="text-xl font-black text-white">{totalDuration}분</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-gray-500 font-bold uppercase tracking-widest">출발 추천 시각</span>
            <span className="text-xl font-black text-purple-500">{getDepartureRecommendation() || '--:--'}</span>
          </div>
          <p className="mt-2 text-[10px] text-gray-600 text-center">
            {todaySchedule?.enabled ? `오늘 ${todaySchedule.time} 등교 기준` : '오늘 등교 정보가 없습니다.'}
          </p>
        </section>

        <button 
          onClick={handleSave}
          className="w-full bg-[#a855f7] hover:bg-[#9333ea] text-white font-bold py-5 rounded-[24px] shadow-lg shadow-purple-500/20 transition-all active:scale-[0.98]"
        >
          설정 저장 및 시작하기
        </button>
        
        <p className="mt-6 text-center text-[11px] text-gray-600 leading-relaxed px-4">
          버스 정류소 번호(ARS-ID)는 지도 앱에서 정류장을 누르면 나오는 5자리 숫자입니다.<br/>
          (예: 08156)
        </p>
      </div>
    </div>
  );
}
