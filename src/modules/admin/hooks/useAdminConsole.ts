import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { matchPath } from 'react-router-dom';
import { ROUTES } from '../../../config/routes';
import { isAbortError } from '../../../shared/utils/abortError';
import { approveBookPublicShare, getPendingPublicBooks, rejectBookPublicShare, type Book } from '../../books';
import { getAdminSystemReport, getAdminUsers, updateAdminUserStatus, type AdminSystemReport, type AdminUser } from '../services/adminService';

type ReadKind = 'users' | 'pending' | 'system';
type ReadTicket = { controller: AbortController; ownerEpoch: number };

export function useAdminConsole(ownerId: string | undefined) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [pendingBooks, setPendingBooks] = useState<Book[]>([]);
  const [systemReport, setSystemReport] = useState<AdminSystemReport | null>(null);
  const [usersError, setUsersError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingBooksError, setPendingBooksError] = useState('');
  const [systemReportError, setSystemReportError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isPendingBooksLoading, setIsPendingBooksLoading] = useState(true);
  const [isSystemLoading, setIsSystemLoading] = useState(true);
  const [updatingUserIds, setUpdatingUserIds] = useState<Set<string>>(() => new Set());
  const [moderatingBookIds, setModeratingBookIds] = useState<Set<string>>(() => new Set());
  const activeRef = useRef(false);
  const ownerEpochRef = useRef(0);
  const readsRef = useRef(new Map<ReadKind, ReadTicket>());
  const actionControllersRef = useRef(new Map<string, AbortController>());
  const updatingUsersRef = useRef(new Set<string>());
  const moderatingBooksRef = useRef(new Set<string>());

  const isCurrentOwner = useCallback((epoch = ownerEpochRef.current) => (
    activeRef.current && epoch === ownerEpochRef.current && matchPath(ROUTES.adminUsers, window.location.pathname) !== null
  ), []);

  const beginRead = useCallback((kind: ReadKind) => {
    if (!isCurrentOwner()) return null;
    readsRef.current.get(kind)?.controller.abort();
    const ticket = { controller: new AbortController(), ownerEpoch: ownerEpochRef.current };
    readsRef.current.set(kind, ticket);
    return ticket;
  }, [isCurrentOwner]);

  const ownsRead = useCallback((kind: ReadKind, ticket: ReadTicket) => (
    isCurrentOwner(ticket.ownerEpoch) && readsRef.current.get(kind) === ticket && !ticket.controller.signal.aborted
  ), [isCurrentOwner]);

  const finishRead = useCallback((kind: ReadKind, ticket: ReadTicket) => {
    if (!ownsRead(kind, ticket)) return false;
    readsRef.current.delete(kind);
    return true;
  }, [ownsRead]);

  const loadUsers = useCallback(async () => {
    if (updatingUsersRef.current.size > 0) return;
    const ticket = beginRead('users');
    if (!ticket) return;
    setIsLoading(true);
    setUsersError('');
    try {
      const result = await getAdminUsers(ticket.controller.signal);
      if (ownsRead('users', ticket)) setUsers(result);
    } catch (error) {
      if (ownsRead('users', ticket) && !isAbortError(error)) {
        setUsersError(error instanceof Error ? error.message : '用户列表加载失败');
      }
    } finally {
      if (finishRead('users', ticket)) setIsLoading(false);
    }
  }, [beginRead, finishRead, ownsRead]);

  const loadPendingBooks = useCallback(async () => {
    if (moderatingBooksRef.current.size > 0) return;
    const ticket = beginRead('pending');
    if (!ticket) return;
    setIsPendingBooksLoading(true);
    setPendingBooksError('');
    try {
      const result = await getPendingPublicBooks(ticket.controller.signal);
      if (ownsRead('pending', ticket)) setPendingBooks(result);
    } catch (error) {
      if (ownsRead('pending', ticket) && !isAbortError(error)) {
        setPendingBooksError(error instanceof Error ? error.message : '审核清单加载失败');
      }
    } finally {
      if (finishRead('pending', ticket)) setIsPendingBooksLoading(false);
    }
  }, [beginRead, finishRead, ownsRead]);

  const loadSystemReport = useCallback(async () => {
    const ticket = beginRead('system');
    if (!ticket) return;
    setIsSystemLoading(true);
    setSystemReport(null);
    setSystemReportError('');
    try {
      const result = await getAdminSystemReport(ticket.controller.signal);
      if (ownsRead('system', ticket)) setSystemReport(result);
    } catch (error) {
      if (ownsRead('system', ticket) && !isAbortError(error)) {
        setSystemReportError(error instanceof Error && error.message ? error.message : '系统状态加载失败');
      }
    } finally {
      if (finishRead('system', ticket)) setIsSystemLoading(false);
    }
  }, [beginRead, finishRead, ownsRead]);

  useLayoutEffect(() => {
    activeRef.current = Boolean(ownerId) && matchPath(ROUTES.adminUsers, window.location.pathname) !== null;
    ownerEpochRef.current += 1;
    updatingUsersRef.current = new Set();
    moderatingBooksRef.current = new Set();
    setUpdatingUserIds(new Set());
    setModeratingBookIds(new Set());
    setUsers([]);
    setPendingBooks([]);
    setSystemReport(null);
    setUsersError('');
    setActionError('');
    setPendingBooksError('');
    setSystemReportError('');
    void loadUsers();
    void loadPendingBooks();
    void loadSystemReport();
    const reads = readsRef.current;
    const actions = actionControllersRef.current;
    return () => {
      activeRef.current = false;
      ownerEpochRef.current += 1;
      reads.forEach((ticket) => ticket.controller.abort());
      reads.clear();
      actions.forEach((controller) => controller.abort());
      actions.clear();
    };
  }, [loadPendingBooks, loadSystemReport, loadUsers, ownerId]);

  const handleStatusChange = async (user: AdminUser) => {
    const pending = updatingUsersRef.current;
    if (!isCurrentOwner() || user.id === ownerId || readsRef.current.has('users') || pending.has(user.id)) return;
    const epoch = ownerEpochRef.current;
    const controller = new AbortController();
    actionControllersRef.current.set(`user:${user.id}`, controller);
    pending.add(user.id);
    setUpdatingUserIds(new Set(pending));
    setActionError('');
    try {
      const result = await updateAdminUserStatus(user.id, user.status === 'active' ? 'disabled' : 'active', controller.signal);
      if (isCurrentOwner(epoch) && !controller.signal.aborted) setUsers((current) => current.map((item) => item.id === result.id ? result : item));
    } catch (error) {
      if (isCurrentOwner(epoch) && !controller.signal.aborted && !isAbortError(error)) setActionError(error instanceof Error ? error.message : '账号状态更新失败');
    } finally {
      if (actionControllersRef.current.get(`user:${user.id}`) === controller) actionControllersRef.current.delete(`user:${user.id}`);
      pending.delete(user.id);
      if (isCurrentOwner(epoch) && !controller.signal.aborted) setUpdatingUserIds(new Set(pending));
    }
  };

  const handleModerateBook = async (book: Book, action: 'approve' | 'reject') => {
    const pending = moderatingBooksRef.current;
    if (!isCurrentOwner() || readsRef.current.has('pending') || pending.has(book.id)) return;
    const epoch = ownerEpochRef.current;
    const controller = new AbortController();
    actionControllersRef.current.set(`book:${book.id}`, controller);
    pending.add(book.id);
    setModeratingBookIds(new Set(pending));
    setActionError('');
    try {
      await (action === 'approve' ? approveBookPublicShare(book.id, controller.signal) : rejectBookPublicShare(book.id, controller.signal));
      if (isCurrentOwner(epoch) && !controller.signal.aborted) setPendingBooks((current) => current.filter((candidate) => candidate.id !== book.id));
    } catch (error) {
      if (isCurrentOwner(epoch) && !controller.signal.aborted && !isAbortError(error)) setActionError(error instanceof Error ? error.message : '公共书库审核失败');
    } finally {
      if (actionControllersRef.current.get(`book:${book.id}`) === controller) actionControllersRef.current.delete(`book:${book.id}`);
      pending.delete(book.id);
      if (isCurrentOwner(epoch) && !controller.signal.aborted) setModeratingBookIds(new Set(pending));
    }
  };

  return {
    users, pendingBooks, systemReport,
    errorMessage: [usersError, actionError].filter(Boolean).join('；'),
    pendingBooksError, systemReportError, isLoading, isPendingBooksLoading, isSystemLoading,
    updatingUserIds, moderatingBookIds, loadUsers, loadPendingBooks, loadSystemReport,
    handleStatusChange, handleModerateBook,
  };
}
