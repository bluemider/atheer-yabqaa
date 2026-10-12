import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { CommunitySubmission, SiteContent } from '../types';
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';

interface FirebaseContextType {
  currentUser: any | null;
  isAdmin: boolean;
  isAuthLoading: boolean;
  isFirestoreConnected: boolean;
  signInWithGoogle: () => Promise<any | null>;
  signOutUser: () => Promise<void>;
  saveSiteContentToFirestore: (content: SiteContent) => Promise<boolean>;
  fetchSiteContentFromFirestore: () => Promise<SiteContent | null>;
  submitMemoryToFirestore: (
    data: {
      authorName: string;
      relationship?: string;
      message: string;
      mediaUrl?: string;
      mediaType?: 'image' | 'video';
    }
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
  updateSubmissionInFirestore: (id: string, updates: Partial<CommunitySubmission>) => Promise<boolean>;
  deleteSubmissionFromFirestore: (id: string) => Promise<boolean>;
  subscribeToApprovedSubmissions: (callback: (submissions: CommunitySubmission[]) => void) => () => void;
  subscribeToAllSubmissions: (callback: (submissions: CommunitySubmission[]) => void) => () => void;
}

const FirebaseContext = createContext<FirebaseContextType | undefined>(undefined);

export const FirebaseProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<any | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [isFirestoreConnected, setIsFirestoreConnected] = useState(false);

  const isAdmin = true;

  // Sign In stub (admin uses direct admin password login)
  const signInWithGoogle = async (): Promise<any | null> => {
    return null;
  };

  // Sign out
  const signOutUser = async (): Promise<void> => {
    setCurrentUser(null);
  };

  // Save full site content via API
  const saveSiteContentToFirestore = async (content: SiteContent): Promise<boolean> => {
    try {
      const res = await fetch('/api/content', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  // Fetch site content via API
  const fetchSiteContentFromFirestore = async (): Promise<SiteContent | null> => {
    try {
      const res = await fetch('/api/content');
      if (res.ok) {
        const data = await res.json();
        return data?.content || null;
      }
      return null;
    } catch {
      return null;
    }
  };

  // Submit visitor condolence/memory directly to Firestore & API
  const submitMemoryToFirestore = async (data: {
    authorName: string;
    relationship?: string;
    message: string;
    mediaUrl?: string;
    mediaType?: 'image' | 'video';
  }): Promise<{ success: boolean; id?: string; error?: string }> => {
    const newId = 'sub-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    const payload: CommunitySubmission = {
      id: newId,
      authorName: data.authorName.trim(),
      relationship: (data.relationship || 'أحد محبي وعارفي الشيخ').trim(),
      message: data.message.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    if (data.mediaUrl && data.mediaUrl.trim().length > 0) {
      payload.mediaUrl = data.mediaUrl;
      payload.mediaType = data.mediaType || (data.mediaUrl.startsWith('data:video') ? 'video' : 'image');
    }

    let firestoreSuccess = false;
    try {
      await setDoc(doc(db, 'submissions', newId), payload);
      firestoreSuccess = true;
    } catch (fsErr: any) {
      console.warn('Direct Firestore submission write notice:', fsErr);
    }

    let serverSuccess = false;
    try {
      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) serverSuccess = true;
    } catch (apiErr) {
      console.warn('Server API submission write notice:', apiErr);
    }

    if (firestoreSuccess || serverSuccess) {
      return { success: true, id: newId };
    }
    return { success: false, error: 'تعذر حفظ المشاركة، يرجى المحاولة مجدداً' };
  };

  // Update submission status via Firestore & API
  const updateSubmissionInFirestore = async (
    id: string,
    updates: Partial<CommunitySubmission>
  ): Promise<boolean> => {
    try {
      await updateDoc(doc(db, 'submissions', id), updates);
    } catch (fsErr) {
      console.warn('Firestore updateDoc notice:', fsErr);
    }

    try {
      const res = await fetch(`/api/submissions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      return res.ok;
    } catch {
      return true;
    }
  };

  // Delete submission via Firestore & API
  const deleteSubmissionFromFirestore = async (id: string): Promise<boolean> => {
    try {
      await deleteDoc(doc(db, 'submissions', id));
    } catch (fsErr) {
      console.warn('Firestore deleteDoc notice:', fsErr);
    }

    try {
      const res = await fetch(`/api/submissions/${id}`, {
        method: 'DELETE',
      });
      return res.ok;
    } catch {
      return true;
    }
  };

  // Fetch approved submissions for the public wall (Real-time Firestore listener with API fallback)
  const subscribeToApprovedSubmissions = (
    callback: (submissions: CommunitySubmission[]) => void
  ): (() => void) => {
    let isCancelled = false;
    let firestoreLoaded = false;

    // 1. Live real-time listener from Google Cloud Firestore
    let unsubFirestore: (() => void) | null = null;
    try {
      const q = query(collection(db, 'submissions'), where('status', '==', 'approved'));
      unsubFirestore = onSnapshot(
        q,
        (snapshot) => {
          if (isCancelled) return;
          firestoreLoaded = true;
          const list: CommunitySubmission[] = [];
          snapshot.forEach((snapDoc) => {
            const data = snapDoc.data() as CommunitySubmission;
            list.push({ ...data, id: snapDoc.id });
          });
          list.sort(
            (a, b) =>
              new Date(b.approvedAt || b.createdAt || 0).getTime() -
              new Date(a.approvedAt || a.createdAt || 0).getTime()
          );
          callback(list);
        },
        (err) => {
          console.warn('Firestore approved submissions listener notice:', err);
        }
      );
    } catch (e) {
      console.warn('Firestore listener setup notice:', e);
    }

    // 2. Initial fetch & periodic fallback from API
    const fetchApiItems = async () => {
      if (firestoreLoaded) return;
      try {
        const res = await fetch('/api/published-archive');
        if (res.ok && !isCancelled && !firestoreLoaded) {
          const data = await res.json();
          if (Array.isArray(data.submissions)) {
            callback(data.submissions);
          }
        }
      } catch {}
    };

    fetchApiItems();
    const interval = setInterval(fetchApiItems, 25000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
      if (unsubFirestore) {
        unsubFirestore();
      }
    };
  };

  // Fetch all submissions for the admin dashboard (Real-time Firestore listener with API fallback)
  const subscribeToAllSubmissions = (
    callback: (submissions: CommunitySubmission[]) => void
  ): (() => void) => {
    let isCancelled = false;
    let firestoreLoaded = false;

    // 1. Live real-time listener from Google Cloud Firestore
    let unsubFirestore: (() => void) | null = null;
    try {
      unsubFirestore = onSnapshot(
        collection(db, 'submissions'),
        (snapshot) => {
          if (isCancelled) return;
          firestoreLoaded = true;
          const list: CommunitySubmission[] = [];
          snapshot.forEach((snapDoc) => {
            const data = snapDoc.data() as CommunitySubmission;
            list.push({ ...data, id: snapDoc.id });
          });
          list.sort(
            (a, b) =>
              new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
          );
          callback(list);
        },
        (err) => {
          console.warn('Firestore all submissions listener notice:', err);
        }
      );
    } catch (e) {
      console.warn('Firestore all listener setup notice:', e);
    }

    // 2. Initial fetch & periodic fallback from API
    const fetchApiItems = async () => {
      if (firestoreLoaded) return;
      try {
        const res = await fetch('/api/submissions');
        if (res.ok && !isCancelled && !firestoreLoaded) {
          const data = await res.json();
          if (Array.isArray(data.submissions)) {
            callback(data.submissions);
          }
        }
      } catch {}
    };

    fetchApiItems();
    const interval = setInterval(fetchApiItems, 15000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
      if (unsubFirestore) {
        unsubFirestore();
      }
    };
  };

  const value = {
    currentUser,
    isAdmin,
    isAuthLoading,
    isFirestoreConnected,
    signInWithGoogle,
    signOutUser,
    saveSiteContentToFirestore,
    fetchSiteContentFromFirestore,
    submitMemoryToFirestore,
    updateSubmissionInFirestore,
    deleteSubmissionFromFirestore,
    subscribeToApprovedSubmissions,
    subscribeToAllSubmissions,
  };

  return <FirebaseContext.Provider value={value}>{children}</FirebaseContext.Provider>;
};

export const useFirebase = (): FirebaseContextType => {
  const context = useContext(FirebaseContext);
  if (!context) {
    throw new Error('useFirebase must be used within a FirebaseProvider');
  }
  return context;
};
