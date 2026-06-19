import { useState, useEffect, useCallback } from 'react';
import {
  doc, onSnapshot, setDoc, serverTimestamp,
} from 'firebase/firestore';
import {
  onAuthStateChanged, signInAnonymously,
  signInWithPopup, signOut, linkWithPopup,
} from 'firebase/auth';
import { auth, db, googleProvider } from '../firebase';
import { emptyData, normalizeData } from '../lib/data';

function ledgerRef(userId) {
  return doc(db, 'ledgers', userId);
}

export function useFirestoreStore() {
  const [data, setDataState] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    let unsubData = () => {};

    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      unsubData();
      setUser(u);

      if (!u) {
        setDataState(null);
        setLoaded(false);
        try {
          await signInAnonymously(auth);
        } catch (e) {
          setAuthError('로그인에 실패했어요. Firebase Authentication에서 익명 로그인을 켜주세요.');
          setLoaded(true);
        }
        return;
      }

      setAuthError(null);
      unsubData = onSnapshot(
        ledgerRef(u.uid),
        (snap) => {
          setDataState(snap.exists() ? normalizeData(snap.data()) : emptyData());
          setLoaded(true);
        },
        () => {
          setAuthError('데이터를 불러오지 못했어요.');
          setLoaded(true);
        },
      );
    });

    return () => {
      unsubAuth();
      unsubData();
    };
  }, []);

  const setData = useCallback(async (next) => {
    if (!user) return;
    setDataState(next);
    try {
      await setDoc(ledgerRef(user.uid), { ...next, updatedAt: serverTimestamp() });
      setSaveError(false);
    } catch (e) {
      setSaveError(true);
    }
  }, [user]);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      if (user?.isAnonymous) {
        await linkWithPopup(user, googleProvider);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (e) {
      if (e.code === 'auth/credential-already-in-use') {
        await signInWithPopup(auth, googleProvider);
        return;
      }
      if (e.code !== 'auth/popup-closed-by-user') {
        setAuthError('Google 로그인에 실패했어요.');
      }
    }
  }, [user]);

  const handleSignOut = useCallback(async () => {
    await signOut(auth);
    await signInAnonymously(auth);
  }, []);

  const isAnonymous = user?.isAnonymous ?? true;

  return {
    data,
    setData,
    loaded,
    saveError,
    user,
    authError,
    isAnonymous,
    signInWithGoogle,
    signOut: handleSignOut,
  };
}
