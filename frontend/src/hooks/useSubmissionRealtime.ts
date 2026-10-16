import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { realtimeOrigin } from '../services/api';

export type RealtimeConnection = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

export function useSubmissionRealtime(submissionId: string | undefined): RealtimeConnection {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<RealtimeConnection>('connecting');

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setConnection('unavailable');
      return;
    }

    let hasConnected = false;
    const socket = io(realtimeOrigin, { auth: { token } });
    socket.on('connect', () => {
      hasConnected = true;
      setConnection('live');
      if (submissionId) {
        void queryClient.invalidateQueries({ queryKey: ['submission', submissionId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    });
    socket.on('disconnect', () => setConnection(hasConnected ? 'reconnecting' : 'unavailable'));
    socket.on('connect_error', () => setConnection(hasConnected ? 'reconnecting' : 'unavailable'));
    socket.onAny((eventName: string, payload: unknown) => {
      if (!eventName.startsWith('submission:') || !isSubmissionEvent(payload)) return;
      if (submissionId && payload.submissionId !== submissionId) return;
      if (submissionId) {
        void queryClient.invalidateQueries({ queryKey: ['submission', submissionId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
    });

    return () => {
      socket.disconnect();
    };
  }, [queryClient, submissionId]);

  return connection;
}

function isSubmissionEvent(value: unknown): value is { submissionId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'submissionId' in value &&
    typeof value.submissionId === 'string'
  );
}
