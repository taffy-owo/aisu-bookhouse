import { AlertCircle, Eye, EyeOff, KeyRound, ListPlus, LoaderCircle, Plus, Save, Server, Trash2 } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useSession } from '../../../app/SessionContext';
import { cn } from '../../../shared/utils/cn';
import { isAbortError } from '../../../shared/utils/abortError';
import { useFocusOwnership } from '../../../shared/hooks/useFocusOwnership';
import { subscribeAiConfigurationChanges } from '../services/aiConfigurationEvents';
import { reconcileChannelModels } from '../services/channelDraftReconciliation';
import { channelModelField, focusSettingsField, getChannelValidationIssues, type ChannelModelDraft } from '../services/settingsValidation';
import { MAX_ENABLED_CHANNEL_MODELS, modelsForChannelSave } from '../services/channelModelSelection';
import {
  createAiChannel,
  deleteAiChannel,
  getAiChannels,
  probeAiChannel,
  updateAiChannel,
  type AiChannel,
  type AiChannelModel,
} from '../services/aiChannelService';

type RequestState = 'idle' | 'loading' | 'success' | 'error';

const CONCURRENCY_OPTIONS = Array.from({ length: 16 }, (_, index) => index + 1);
type ChannelAction = 'edit' | 'toggle' | 'delete';
type ChannelError = { message: string; readSequence: number };
type ChannelActionError = ChannelError & { action: 'toggle' | 'delete' };
type ChannelInteraction = { confirmedReadSequence: number; getReadSequence: () => number; ownsFocus: (container: Element | null) => boolean };

export function AiChannelSettings() {
  const { session } = useSession();
  const [channels, setChannels] = useState<Array<AiChannel & { removed?: boolean }> | null>(null);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reloadControllerRef = useRef<AbortController | null>(null);
  const readSequenceRef = useRef(0);
  const [confirmedReadSequence, setConfirmedReadSequence] = useState(0);
  const refreshRef = useRef<(() => void) | null>(null);
  const editingIdsRef = useRef(new Set<string>());
  const sectionRef = useRef<HTMLElement | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id?: string; action: ChannelAction; previous: Element | null; accountId?: string } | null>(null);
  const handledFocusRef = useRef<typeof focusRequest>(null);
  const ownsFocus = useFocusOwnership();
  const interaction: ChannelInteraction = {
    confirmedReadSequence,
    getReadSequence: () => readSequenceRef.current,
    ownsFocus,
  };

  const requestFocus = (id?: string, action: ChannelAction = 'edit') => {
    setFocusRequest({ id, action, previous: document.activeElement, accountId: session?.id });
  };
  useLayoutEffect(() => {
    const root = sectionRef.current;
    if (!root || !focusRequest || handledFocusRef.current === focusRequest || focusRequest.accountId !== session?.id) return;
    handledFocusRef.current = focusRequest;
    if (document.activeElement !== focusRequest.previous && document.activeElement !== document.body) return;
    const row = [...root.querySelectorAll<HTMLElement>('[data-channel-id]')].find((element) => element.dataset.channelId === focusRequest.id);
    const target = row?.querySelector<HTMLButtonElement>(`[data-channel-action="${focusRequest.action}"]`) ?? root.querySelector<HTMLButtonElement>('[data-channel-add]');
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [channels, creating, focusRequest, session?.id]);

  const afterMutation = () => {
    if (reloadControllerRef.current) {
      reloadControllerRef.current.abort();
      refreshRef.current?.();
    }
  };

  const applyChannel = (saved: AiChannel) => {
    afterMutation();
    setChannels((current) => {
      const entries = current ?? [];
      return (entries.some((item) => item.id === saved.id)
        ? entries.map((item) => item.id === saved.id ? saved : item)
        : [...entries, saved]).sort((a, b) => a.sort_order - b.sort_order);
    });
  };

  useEffect(() => {
    let active = true;
    reloadControllerRef.current?.abort();
    editingIdsRef.current.clear();
    setChannels(null);
    setCreating(false);
    setLoadError('');
    const refresh = () => {
      reloadControllerRef.current?.abort();
      const controller = new AbortController();
      const readSequence = ++readSequenceRef.current;
      reloadControllerRef.current = controller;
      setLoadError('');
      void getAiChannels(controller.signal).then((next) => {
        if (!active || controller.signal.aborted) return;
        setConfirmedReadSequence(readSequence);
        setChannels((current) => [...next, ...(current ?? []).filter((item) => editingIdsRef.current.has(item.id) && !next.some((incoming) => incoming.id === item.id)).map((item) => ({ ...item, removed: true }))]);
      }).catch((error: unknown) => {
        if (active && !controller.signal.aborted && !isAbortError(error)) setLoadError(error instanceof Error ? error.message : '渠道读取失败');
      }).finally(() => { if (reloadControllerRef.current === controller) reloadControllerRef.current = null; });
    };
    refreshRef.current = refresh;
    const unsubscribe = subscribeAiConfigurationChanges('provider', refresh);
    refresh();
    return () => {
      active = false;
      reloadControllerRef.current?.abort();
      reloadControllerRef.current = null;
      refreshRef.current = null;
      unsubscribe();
    };
  }, [session?.id, reloadKey]);

  if (loadError && !channels) return <div className="flex flex-wrap items-center gap-3 py-5" role="alert"><p className="min-w-0 max-w-full break-words text-sm text-red-600 [overflow-wrap:anywhere] dark:text-red-300">{loadError}</p><button className="min-h-11 px-3 text-sm font-medium text-accent" onClick={() => setReloadKey((current) => current + 1)} type="button">重试读取翻译渠道</button></div>;
  if (!channels) {
    return (
      <div className="flex min-h-28 items-center gap-2 py-5 text-sm text-stone-500">
        <LoaderCircle className="h-4 w-4 animate-spin" />正在读取翻译渠道
      </div>
    );
  }

  return (
    <section aria-label="翻译渠道设置" className="border-t border-ink/[0.07] py-6 dark:border-white/10" ref={sectionRef}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-stone-900 dark:text-night-ink">翻译渠道</h2>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            整本精翻会使用提交时选定的渠道和模型。站点渠道计入公共日额度，自带 Key 独立记账。
          </p>
        </div>
        <button
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-deep disabled:opacity-40"
          disabled={creating}
          data-channel-add
          onClick={() => setCreating(true)}
          type="button"
        >
          <Plus className="h-4 w-4" />添加渠道
        </button>
      </div>

      {creating && (
        <ChannelEditor
          channel={null}
          interaction={interaction}
          onCancel={() => { setCreating(false); requestFocus(); }}
          onSaved={(saved, restoreFocus) => { applyChannel(saved); setCreating(false); if (restoreFocus) requestFocus(saved.id); }}
        />
      )}

      {loadError && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-red-600 dark:text-red-300" role="alert"><span className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">{loadError}；当前列表和编辑内容已保留。</span><button className="min-h-10 px-2 font-medium text-accent" onClick={() => refreshRef.current?.()} type="button">重试同步渠道</button></div>}

      {channels.length === 0 && !creating && (
        <p className="mt-6 text-sm text-stone-500 dark:text-stone-400">还没有渠道，点「添加渠道」开始配置。</p>
      )}

      <div className="mt-4 divide-y divide-ink/[0.07] dark:divide-white/10">
        {channels.map((channel) => (
          <ChannelRow channel={channel} key={channel.id} removed={channel.removed} onReload={() => refreshRef.current?.()} onEditingChange={(editing) => { if (editing) editingIdsRef.current.add(channel.id); else editingIdsRef.current.delete(channel.id); }} onChanged={applyChannel}
            interaction={interaction}
            onRequestFocus={requestFocus}
            onDeleted={(id, restoreFocus = false) => {
              afterMutation(); editingIdsRef.current.delete(id);
              setChannels((current) => current?.filter((item) => item.id !== id) ?? []);
              if (restoreFocus) {
                const remaining = channels.filter((item) => item.id !== id);
                const next = remaining[Math.min(channels.findIndex((item) => item.id === id), remaining.length - 1)];
                requestFocus(next?.id);
              }
            }} />
        ))}
      </div>
    </section>
  );
}

function ChannelRow({ channel, removed = false, interaction, onChanged, onDeleted, onReload, onEditingChange, onRequestFocus }: { channel: AiChannel; removed?: boolean; interaction: ChannelInteraction; onChanged: (saved: AiChannel) => void; onDeleted: (id: string, restoreFocus?: boolean) => void; onReload: () => void; onEditingChange: (editing: boolean) => void; onRequestFocus: (id: string, action?: ChannelAction) => void }) {
  const { confirmedReadSequence, getReadSequence, ownsFocus } = interaction;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChannelActionError | null>(null);
  const mountedRef = useRef(true);
  const actionControllerRef = useRef<AbortController | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const reloadFocusRef = useRef<Element | null>(null);
  // Only a successful read started after the failure acknowledges that error.
  // An older in-flight snapshot must not dismiss a newly failed action.
  const visibleError = error && confirmedReadSequence <= error.readSequence ? error : null;

  useLayoutEffect(() => {
    const previousFocus = reloadFocusRef.current;
    if (visibleError || !previousFocus) return;
    reloadFocusRef.current = null;
    if (ownsFocus(previousFocus)) onRequestFocus(channel.id, error?.action);
  }, [channel.id, error?.action, onRequestFocus, ownsFocus, visibleError]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionControllerRef.current?.abort();
      actionControllerRef.current = null;
    };
  }, []);

  const enabledModels = channel.models.filter((model) => model.enabled);
  const unavailable = enabledModels.filter((model) => !model.available);

  const remove = async () => {
    if (actionControllerRef.current) return;
    if (!window.confirm(`删除渠道「${channel.name}」？该渠道下的模型将不再可选。${channel.is_provider_default ? '\n\n同时移除关联的日文翻译配置，听书配置会保留。' : ''}`)) return;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setBusy(true);
    reloadFocusRef.current = null;
    setError(null);
    let deleted = false;
    try {
      await deleteAiChannel(channel.id, controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      deleted = true;
      onDeleted(channel.id, ownsFocus(rowRef.current));
    } catch (deleteError: unknown) {
      if (!controller.signal.aborted && mountedRef.current && !isAbortError(deleteError)) {
        setError({ message: deleteError instanceof Error ? deleteError.message : '删除失败', readSequence: getReadSequence(), action: 'delete' });
      }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) {
        setBusy(false);
        if (!deleted && ownsFocus(rowRef.current)) onRequestFocus(channel.id, 'delete');
      }
    }
  };

  const toggleEnabled = async () => {
    if (actionControllerRef.current) return;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setBusy(true);
    reloadFocusRef.current = null;
    setError(null);
    try {
      const saved = await updateAiChannel(channel.id, { expectedUpdatedAt: channel.updated_at, enabled: !channel.enabled, signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      onChanged(saved);
    } catch (toggleError: unknown) {
      if (!controller.signal.aborted && mountedRef.current && !isAbortError(toggleError)) {
        setError({ message: toggleError instanceof Error ? toggleError.message : '更新失败', readSequence: getReadSequence(), action: 'toggle' });
      }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) {
        setBusy(false);
        if (ownsFocus(rowRef.current)) onRequestFocus(channel.id, 'toggle');
      }
    }
  };

  if (editing) {
    return (
      <ChannelEditor
        channel={removed ? null : channel}
        interaction={interaction}
        sourceRemoved={removed}
        onReload={onReload}
        onCancel={() => { onEditingChange(false); setEditing(false); if (removed) onDeleted(channel.id, true); else onRequestFocus(channel.id); }}
        onSaved={(saved, restoreFocus) => { onEditingChange(false); if (removed) onDeleted(channel.id); onChanged(saved); setEditing(false); if (restoreFocus) onRequestFocus(saved.id); }}
      />
    );
  }

  return (
    <div className="py-5" data-channel-id={channel.id} ref={rowRef}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-stone-900 dark:text-night-ink">
            <span className="min-w-0 [overflow-wrap:anywhere]">{channel.name}</span>
            <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', channel.credential_scope === 'platform' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' : 'bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-night-soft')}>
              {channel.credential_scope === 'platform' ? '站点额度' : '自带 Key'}
            </span>
            {!channel.enabled && <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] font-normal text-stone-600 dark:bg-white/10 dark:text-night-soft">已停用</span>}
          </h3>
          <p className="mt-1 break-all text-xs text-stone-500 dark:text-stone-400">{channel.base_url}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button aria-label={`${channel.enabled ? '停用' : '启用'}渠道 ${channel.name}`} data-channel-action="toggle" className="min-h-9 px-2 text-xs text-stone-500 transition hover:text-accent disabled:opacity-40" disabled={busy} onClick={() => void toggleEnabled()} type="button">
            {channel.enabled ? '停用' : '启用'}
          </button>
          <button aria-label={`编辑渠道 ${channel.name}`} data-channel-action="edit" className="min-h-9 px-2 text-xs text-stone-500 transition hover:text-accent disabled:opacity-40" disabled={busy} onClick={() => { onEditingChange(true); setEditing(true); }} type="button">编辑</button>
          <button aria-label={`删除渠道 ${channel.name}`} data-channel-action="delete" className="grid h-9 w-9 place-items-center text-stone-400 transition hover:text-red-500 disabled:opacity-40" disabled={busy} onClick={() => void remove()} type="button">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {enabledModels.length === 0 ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">该渠道还没有启用任何模型，点「编辑」获取并勾选。</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {enabledModels.map((model) => (
            <span
              className={cn(
                'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border px-2 py-1 text-[11px]',
                model.available
                  ? 'border-ink/10 text-stone-600 dark:border-white/15 dark:text-night-soft'
                  : 'border-amber-300/60 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-950/20 dark:text-amber-300',
              )}
              key={model.id}
              title={model.available ? undefined : model.unavailable_reason}
            >
              {!model.available && <AlertCircle className="h-3 w-3 shrink-0" />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{model.display_name}</span>
              <span className="shrink-0 whitespace-nowrap text-stone-400">并发 {model.max_concurrency}</span>
            </span>
          ))}
        </div>
      )}
      {unavailable.length > 0 && (
        <p className="mt-2 break-words text-[11px] text-amber-700 [overflow-wrap:anywhere] dark:text-amber-300">
          {unavailable.length} 个模型暂时不可用（{unavailable[0].unavailable_reason}），恢复后会自动重新启用。
        </p>
      )}
      {channel.is_provider_default && <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">地址与密钥和日文翻译设置同步</p>}
      {visibleError && <div className="mt-2 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-300" role="alert"><span>{visibleError.message}</span><button className="min-h-10 px-2 text-accent" onClick={(event) => { reloadFocusRef.current = event.currentTarget; onReload(); }} type="button">重新读取渠道</button></div>}
    </div>
  );
}

type DraftModel = ChannelModelDraft;

function ChannelEditor({ channel, interaction, onCancel, onSaved, onReload, sourceRemoved = false }: {
  channel: AiChannel | null;
  interaction: ChannelInteraction;
  onCancel: () => void;
  onSaved: (saved: AiChannel, restoreFocus: boolean) => void;
  onReload?: () => void;
  sourceRemoved?: boolean;
}) {
  const { confirmedReadSequence, getReadSequence, ownsFocus } = interaction;
  const [name, setName] = useState(channel?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(channel?.base_url ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<DraftModel[]>(() => (channel?.models ?? []).map(toDraftModel));
  const [probeState, setProbeState] = useState<RequestState>('idle');
  const [probeDetail, setProbeDetail] = useState('');
  const [saveState, setSaveState] = useState<RequestState>('idle');
  const [saveError, setSaveError] = useState<ChannelError | null>(null);
  const mountedRef = useRef(true);
  const probeRequestIdRef = useRef(0);
  const probeControllerRef = useRef<AbortController | null>(null);
  const probeButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnProbeFocusRef = useRef(false);
  const saveControllerRef = useRef<AbortController | null>(null);
  const acknowledgedRef = useRef(channel);
  const [refreshNotice, setRefreshNotice] = useState('');
  const formRef = useRef<HTMLFormElement | null>(null);
  const saveFocusRef = useRef<HTMLElement | null>(null);
  const reloadFocusRef = useRef<Element | null>(null);
  const validationId = useId();
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const visibleSaveError = saveError && (!onReload || confirmedReadSequence <= saveError.readSequence) ? saveError : null;

  useLayoutEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>('[data-validation-field="name"]')?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (!returnProbeFocusRef.current || probeState === 'loading') return;
    returnProbeFocusRef.current = false;
    const button = probeButtonRef.current;
    if (button && !button.disabled && document.activeElement === document.body && ownsFocus(formRef.current)) button.focus({ preventScroll: true });
  }, [ownsFocus, probeState]);
  useLayoutEffect(() => {
    const target = saveFocusRef.current;
    if (saveState !== 'error' || !target) return;
    saveFocusRef.current = null;
    if (document.activeElement === document.body && ownsFocus(formRef.current)) target.focus({ preventScroll: true });
  }, [ownsFocus, saveState]);
  useLayoutEffect(() => {
    const previousFocus = reloadFocusRef.current;
    if (visibleSaveError || !previousFocus) return;
    reloadFocusRef.current = null;
    if (ownsFocus(previousFocus)) {
      const form = formRef.current;
      const submit = form?.querySelector<HTMLButtonElement>('button[type=submit]');
      const target = submit && !submit.disabled ? submit : form?.querySelector<HTMLInputElement>('[data-validation-field=name]');
      target?.focus({ preventScroll: true });
    }
  }, [ownsFocus, visibleSaveError]);

  useEffect(() => {
    const previous = acknowledgedRef.current;
    acknowledgedRef.current = channel;
    if (!channel || !previous || previous.updated_at === channel.updated_at) return;
    setName((current) => current === previous.name ? channel.name : current);
    setBaseUrl((current) => current === previous.base_url ? channel.base_url : current);
    setModels((current) => reconcileChannelModels(current, previous.models.map(toDraftModel), channel.models.map(toDraftModel)));
    probeRequestIdRef.current += 1; probeControllerRef.current?.abort();
    probeControllerRef.current = null;
    setProbeState('idle'); setProbeDetail('');
    setRefreshNotice('渠道资料已同步，未保存的修改已保留。');
  }, [channel]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      probeRequestIdRef.current += 1;
      probeControllerRef.current?.abort();
      probeControllerRef.current = null;
      saveControllerRef.current?.abort();
      saveControllerRef.current = null;
    };
  }, []);

  const selectedModels = modelsForChannelSave(models, channel?.models ?? []);
  const enabledModelCount = selectedModels.filter((item) => item.enabled).length;
  const tooManyModels = enabledModelCount > MAX_ENABLED_CHANNEL_MODELS;
  const canSave = saveState !== 'loading' && !tooManyModels && (!sourceRemoved || Boolean(apiKey.trim()));
  const validationIssues = getChannelValidationIssues({ name, baseUrl, apiKey, keyConfigured: Boolean(channel?.api_key_configured), models: selectedModels });
  const fieldError = (field: string) => touchedFields.has(field) ? validationIssues.find((issue) => issue.field === field)?.message : undefined;
  const errorId = (field: string) => `${validationId}-${encodeURIComponent(field)}-error`;
  const inputId = (field: string) => `${validationId}-${encodeURIComponent(field)}-input`;
  const validationProps = (field: string) => ({ id: inputId(field), 'data-validation-field': field, 'aria-invalid': fieldError(field) ? true : undefined, 'aria-describedby': fieldError(field) ? errorId(field) : undefined });
  const errorMessage = (field: string) => fieldError(field) ? <p className="mt-1 basis-full text-xs leading-5 text-red-600 dark:text-red-300" id={errorId(field)}>{fieldError(field)}</p> : null;

  const credentialsChanged = Boolean(channel && (baseUrl.trim() !== channel.base_url || apiKey.trim()));
  const invalidateProbe = () => {
    probeRequestIdRef.current += 1;
    probeControllerRef.current?.abort();
    probeControllerRef.current = null;
    setProbeState('idle');
    setProbeDetail('');
  };

  const probe = async () => {
    if (saveControllerRef.current || probeControllerRef.current || credentialsChanged) return;
    if (!channel) {
      setProbeState('error');
      setProbeDetail('请先保存渠道，再获取模型列表');
      return;
    }
    const requestId = ++probeRequestIdRef.current;
    const controller = new AbortController();
    probeControllerRef.current = controller;
    returnProbeFocusRef.current = false;
    setProbeState('loading');
    setProbeDetail('');
    try {
      const result = await probeAiChannel(channel.id, controller.signal);
      if (!mountedRef.current || requestId !== probeRequestIdRef.current) return;
      if (!result.ok) {
        setProbeState('error');
        setProbeDetail(result.detail);
        return;
      }
      setModels((current) => {
        const known = new Map(current.map((item) => [item.model, item]));
        // Keep everything already configured, append whatever the channel added.
        const merged = [...new Set(result.models.map((model) => model.trim()).filter(Boolean))].map((model) => known.get(model) ?? {
          model,
          enabled: false,
          maxConcurrency: 4,
          chunkCharacters: 4500,
          chunkParagraphs: 220,
        });
        const missing = current.filter((item) => !result.models.includes(item.model));
        return [...merged, ...missing];
      });
      setProbeState('success');
      setProbeDetail(result.detail);
    } catch (error: unknown) {
      if (!mountedRef.current || requestId !== probeRequestIdRef.current) return;
      if (controller.signal.aborted) return;
      setProbeState('error');
      setProbeDetail(error instanceof Error ? error.message : '连接失败');
    } finally {
      if (probeControllerRef.current === controller) probeControllerRef.current = null;
      if (mountedRef.current && !controller.signal.aborted && document.activeElement === document.body && ownsFocus(formRef.current)) {
        returnProbeFocusRef.current = true;
      }
    }
  };

  const save = async () => {
    if (saveControllerRef.current) return;
    if (validationIssues.length) {
      setTouchedFields((current) => new Set([...current, ...validationIssues.map((issue) => issue.field)]));
      focusSettingsField(formRef.current, validationIssues[0].field);
      return;
    }
    if (!canSave) return;
    probeRequestIdRef.current += 1;
    probeControllerRef.current?.abort();
    probeControllerRef.current = null;
    const controller = new AbortController();
    saveControllerRef.current = controller;
    saveFocusRef.current = document.activeElement instanceof HTMLElement && formRef.current?.contains(document.activeElement) ? document.activeElement : null;
    reloadFocusRef.current = null;
    setSaveState('loading');
    setSaveError(null);
    setProbeState('idle');
    setProbeDetail('');
    const payloadModels = selectedModels.map((item) => ({
      model: item.model,
      enabled: item.enabled,
      max_concurrency: item.maxConcurrency,
      chunk_characters: Number(item.chunkCharacters),
      chunk_paragraphs: item.chunkParagraphs,
    }));
    try {
      const saved = channel
        ? await updateAiChannel(channel.id, {
          expectedUpdatedAt: channel.updated_at,
          ...(name.trim() !== channel.name ? { name: name.trim() } : {}),
          ...(baseUrl.trim() !== channel.base_url ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(JSON.stringify(selectedModels.map((item) => ({ ...item, chunkCharacters: Number(item.chunkCharacters) }))) !== JSON.stringify(channel.models.map(toDraftModel)) ? { models: payloadModels } : {}), signal: controller.signal,
        })
        : await createAiChannel({ name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), models: payloadModels, signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      onSaved(saved, ownsFocus(formRef.current));
    } catch (error: unknown) {
      if (mountedRef.current && !controller.signal.aborted) {
        setSaveState('error');
        setSaveError({ message: error instanceof Error ? error.message : '保存失败', readSequence: getReadSequence() });
      }
    } finally {
      if (saveControllerRef.current === controller) saveControllerRef.current = null;
    }
  };

  const updateModel = (model: string, patch: Partial<DraftModel>) => {
    setModels((current) => current.map((item) => (item.model === model ? { ...item, ...patch } : item)));
  };

  return (
    <form aria-busy={saveState === 'loading'} className="mt-4 border border-ink/10 bg-ink/[0.015] p-5 dark:border-white/10 dark:bg-white/[0.02]" noValidate ref={formRef} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {sourceRemoved && <p role="status" className="mb-4 text-xs leading-5 text-amber-700 dark:text-amber-300">原渠道已移除，编辑内容仍保留。填写 API Key 后可重新创建，或取消这份草稿。</p>}
      {channel?.is_provider_default && <p className="mb-4 text-xs leading-5 text-stone-500 dark:text-stone-400">地址与密钥和日文翻译设置同步；模型勾选仅影响整本翻译。</p>}
      {!sourceRemoved && refreshNotice && <p role="status" className="mb-4 text-xs text-stone-500 dark:text-stone-400">{refreshNotice}</p>}
      <fieldset className="min-w-0" disabled={saveState === 'loading'}>
      <div className="grid gap-x-7 gap-y-5 md:grid-cols-2">
        <div className="block min-w-0">
          <label htmlFor={inputId('name')} className="flex items-center gap-2 text-xs font-medium text-stone-600 dark:text-night-soft">渠道名称</label>
          <input
            {...validationProps('name')}
            autoComplete="off"
            className={fieldClassName}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 CPA 主渠道"
            value={name}
          />
          {errorMessage('name')}
        </div>
        <div className="block min-w-0">
          <label htmlFor={inputId('baseUrl')} className="flex items-center gap-2 text-xs font-medium text-stone-600 dark:text-night-soft"><Server className="h-4 w-4 text-accent" />Base URL</label>
          <input
            {...validationProps('baseUrl')}
            autoComplete="off"
            className={fieldClassName}
            inputMode="url"
            maxLength={500}
            onChange={(event) => { setBaseUrl(event.target.value); invalidateProbe(); }}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            value={baseUrl}
          />
          {errorMessage('baseUrl')}
        </div>
        <div className="block min-w-0 md:col-span-2">
          <label htmlFor={inputId('apiKey')} className="flex items-center gap-2 text-xs font-medium text-stone-600 dark:text-night-soft"><KeyRound className="h-4 w-4 text-accent" />API Key</label>
          <span className="relative mt-2 block">
            <input
              {...validationProps('apiKey')}
              autoComplete="off"
              className={fieldClassName}
              maxLength={4096}
              onChange={(event) => { setApiKey(event.target.value); invalidateProbe(); }}
              placeholder={channel?.api_key_configured ? '已保存，留空不会修改' : 'sk-...'}
              spellCheck={false}
              style={showApiKey ? undefined : ({ WebkitTextSecurity: 'disc' } as CSSProperties)}
              type="text"
              value={apiKey}
            />
            <button aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-stone-400 transition hover:text-accent" onClick={() => setShowApiKey((value) => !value)} type="button">
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </span>
          {errorMessage('apiKey')}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-stone-600 transition hover:text-accent disabled:opacity-40 dark:text-night-soft"
          disabled={!channel || credentialsChanged || probeState === 'loading' || saveState === 'loading'}
          onClick={() => void probe()}
          ref={probeButtonRef}
          title={channel ? undefined : '先保存渠道后即可获取模型'}
          type="button"
        >
          {probeState === 'loading' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ListPlus className="h-4 w-4" />}
          {probeState === 'loading' ? '正在获取' : '获取模型列表'}
        </button>
        {credentialsChanged && <span className="text-xs text-stone-500 dark:text-stone-400">地址或密钥已修改，请先保存后再获取模型。</span>}
        {probeDetail && (
          <span role={probeState === 'error' ? 'alert' : 'status'} className={cn('min-w-0 max-w-full break-words text-xs [overflow-wrap:anywhere]', probeState === 'error' ? 'text-red-600 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300')}>
            {probeDetail}
          </span>
        )}
      </div>

      {models.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-medium text-stone-600 dark:text-night-soft">
            已选择 {enabledModelCount} 个模型，最多启用 {MAX_ENABLED_CHANNEL_MODELS} 个；目录共 {models.length} 个
          </p>
          <div className="mt-2 max-h-80 divide-y divide-ink/[0.06] overflow-y-auto border border-ink/10 reader-scrollbar dark:divide-white/[0.06] dark:border-white/10">
            {models.map((item) => (
              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5" key={item.model}>
                <label className="channel-model-toggle flex min-w-0 flex-1 items-center gap-2.5 text-xs text-stone-700 dark:text-night-copy">
                  <input
                    {...validationProps(channelModelField(item.model, 'model'))}
                    checked={item.enabled}
                    className="h-4 w-4 shrink-0 accent-[--accent]"
                    onChange={(event) => updateModel(item.model, { enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <span className="min-w-0 break-all">{item.model}</span>
                </label>
                {errorMessage(channelModelField(item.model, 'model'))}
                <details className="w-full text-[11px] text-stone-500 dark:text-stone-400 sm:w-auto">
                  <summary className="cursor-pointer py-1.5 focus-visible:outline-2 focus-visible:outline-accent">高级参数</summary>
                  <div className="mt-2 flex flex-wrap items-center gap-3 rounded border border-ink/10 bg-shell p-2 dark:border-white/15 dark:bg-night-surface">
                    <div className="flex max-w-full flex-wrap items-center gap-1.5">
                      <label htmlFor={inputId(channelModelField(item.model, 'maxConcurrency'))}>并发上限</label>
                      <select
                        {...validationProps(channelModelField(item.model, 'maxConcurrency'))}
                        className="h-8 border-0 border-b border-ink/15 bg-transparent px-1 text-xs text-stone-700 outline-none focus:border-accent disabled:opacity-40 dark:border-white/15 dark:text-night-copy"
                        onChange={(event) => updateModel(item.model, { maxConcurrency: Number(event.target.value) })}
                        value={item.maxConcurrency}
                      >
                        {CONCURRENCY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                      {errorMessage(channelModelField(item.model, 'maxConcurrency'))}
                    </div>
                    <div className="flex max-w-full flex-wrap items-center gap-1.5">
                      <label htmlFor={inputId(channelModelField(item.model, 'chunkCharacters'))}>分块字数</label>
                      <input
                        {...validationProps(channelModelField(item.model, 'chunkCharacters'))}
                        className="h-8 w-20 border-0 border-b border-ink/15 bg-transparent px-1 text-xs tabular-nums text-stone-700 outline-none focus:border-accent disabled:opacity-40 dark:border-white/15 dark:text-night-copy"
                        max={20000}
                        min={500}
                        onChange={(event) => updateModel(item.model, { chunkCharacters: event.target.value })}
                        step={1}
                        type="number"
                        value={item.chunkCharacters}
                      />
                      {errorMessage(channelModelField(item.model, 'chunkCharacters'))}
                    </div>
                  </div>
                </details>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-stone-400">
            分块字数决定单次请求的正文长度：渠道会截断长生成时调小，稳定的渠道保持 4500 即可。
          </p>
        </div>
      )}

      {visibleSaveError && <div role="alert" className="mt-3 break-words text-xs text-red-600 [overflow-wrap:anywhere] dark:text-red-300"><span>{visibleSaveError.message}</span>{onReload && <button className="min-h-10 px-2 text-accent" onClick={(event) => { reloadFocusRef.current = event.currentTarget; onReload(); }} type="button">重新读取并保留编辑</button>}</div>}
      {tooManyModels && <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-300">已选择 {enabledModelCount} 个，请减少至 {MAX_ENABLED_CHANNEL_MODELS} 个以内；未勾选的模型不占名额。</p>}

      <div className="mt-5 flex items-center gap-2">
        <button
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-deep disabled:opacity-40"
          disabled={!canSave}
          type="submit"
        >
          {saveState === 'loading' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saveState === 'loading' ? '正在保存…' : channel ? '保存修改' : '创建渠道'}
        </button>
        <button className="min-h-10 px-3 text-sm text-stone-500 transition hover:text-stone-800 dark:hover:text-night-copy" onClick={onCancel} type="button">取消</button>
      </div>
      </fieldset>
    </form>
  );
}

function toDraftModel(model: AiChannelModel): DraftModel {
  return {
    model: model.model,
    enabled: model.enabled,
    maxConcurrency: model.max_concurrency,
    chunkCharacters: model.chunk_characters,
    chunkParagraphs: model.chunk_paragraphs,
  };
}

const fieldClassName = 'mt-2 h-11 w-full border-0 border-b border-ink/15 bg-transparent px-1 pr-10 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-accent dark:border-white/15 dark:text-night-ink dark:placeholder:text-stone-600';
