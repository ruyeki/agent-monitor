import { useCallback, useEffect, useRef, useState } from 'react';
import { discardDraft, getVersions, getWorkflow, loadVersion, publishDraft, putDraft } from '../api.js';

const SAVE_DELAY = 400;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const asError = (e) => (typeof e === 'string' ? { message: e } : e);

// The draft workflow: loading, debounced autosave, publish, discard and loading an old version.
// `tick` changes on every live (SSE) event; unsaved local edits survive a reload.
export function useDraft(tick = 0) {
  const [published, setPublished] = useState(null);
  const [wf, setWf] = useState(null);
  const [status, setStatus] = useState('saved'); // saved | unsaved | saving | error
  const [problem, setProblem] = useState(null); // load / save / publish failures
  const [publishErrors, setPublishErrors] = useState(null); // [{message, node?, edge?}] after a refused publish
  const [versions, setVersions] = useState([]);
  const wfRef = useRef(null);
  const dirty = useRef(false);
  const timer = useRef(null);
  const seq = useRef(0);

  const load = useCallback(async (force) => {
    const mine = seq.current; // an edit made while the fetch is in flight makes its result stale
    try {
      const [state, list] = await Promise.all([getWorkflow(), getVersions()]);
      setPublished(state.published);
      setVersions(list);
      if (seq.current === mine && (force || !dirty.current)) {
        dirty.current = false;
        setStatus('saved');
        if (!same(state.draft.workflow, wfRef.current)) {
          wfRef.current = state.draft.workflow;
          setWf(state.draft.workflow);
        }
      }
      setProblem(null);
    } catch (e) {
      setProblem(`Could not load the workflow: ${e.message}`);
    }
  }, []);
  useEffect(() => {
    load(false);
  }, [load, tick]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const mine = seq.current;
    setStatus('saving');
    try {
      const draft = await putDraft(wfRef.current);
      if (seq.current === mine) {
        setProblem(null);
        dirty.current = false;
        setStatus('saved');
        // keep a shown list of publish errors current while the user fixes them
        setPublishErrors((prev) => (prev ? (draft?.errors?.length ? draft.errors.map(asError) : null) : prev));
      }
      return true;
    } catch (e) {
      if (seq.current === mine) {
        setStatus('error');
        setProblem(`Could not save the draft: ${e.message}`);
      }
      return false;
    }
  }, []);

  const edit = useCallback(
    (next) => {
      wfRef.current = next;
      dirty.current = true;
      seq.current += 1;
      setWf(next);
      setStatus('unsaved');
      clearTimeout(timer.current);
      timer.current = setTimeout(save, SAVE_DELAY);
    },
    [save],
  );

  // Unmounting with a pending edit saves it instead of dropping it.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (dirty.current && wfRef.current) putDraft(wfRef.current).catch(() => {});
    },
    [],
  );

  const publish = useCallback(async () => {
    if (dirty.current && !(await save())) return;
    try {
      await publishDraft();
      setPublishErrors(null);
      await load(true);
    } catch (e) {
      if (e.body?.errors) setPublishErrors(e.body.errors.map(asError));
      else setProblem(`Could not publish: ${e.message}`);
    }
  }, [save, load]);

  // Replaces the draft on the server (discard = no version), then reloads it.
  const replaceDraft = useCallback(
    async (version) => {
      clearTimeout(timer.current);
      seq.current += 1; // a save still in flight belongs to the draft being thrown away
      try {
        if (version == null) await discardDraft();
        else await loadVersion(version);
        setPublishErrors(null);
        await load(true);
      } catch (e) {
        setProblem(e.message);
      }
    },
    [load],
  );

  const hasChanges = !!wf && !!published && (status !== 'saved' || !same(wf, published.workflow));
  return { wf, published, versions, status, problem, publishErrors, hasChanges, edit, publish, replaceDraft };
}
