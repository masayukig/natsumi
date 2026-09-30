import { useRef } from 'preact/hooks';
import { PLACEMENTS, type Placement } from '../../shared/protocol/conversation.ts';
import type { ApprovalProps } from '../core/props.ts';
import { Images, type Dispatch } from './parts.tsx';

/**
 * An approval waiting for the owner. Its buttons only choose; what will happen is asked once more, and only that
 * confirmation hands back the decision to send (ADR 0058).
 */
export function ApprovalCard({ props, dispatch }: { props: ApprovalProps; dispatch: Dispatch }) {
  const draft = useRef<HTMLTextAreaElement>(null);
  const placement = useRef<HTMLSelectElement>(null);
  const approvalId = props.id;
  const chosen = () => PLACEMENTS.find((value: Placement) => value === placement.current?.value);
  const choose = (decision: 'approve' | 'edit' | 'reject') => dispatch({
    type: 'approval-choose', approvalId, decision,
    ...(decision === 'edit' ? { text: draft.current?.value ?? '' } : {}),
    ...(chosen() ? { placement: chosen()! } : {}),
  });

  return (
    <article class={`approval ${props.mode}`} data-approval-id={approvalId}>
      <p class="meta">
        <span class="channel">{props.channel}</span>
        <span class="verdict">{props.verdict}</span>
        <time>{props.expires}</time>
      </p>
      {props.replyTo && (
        <blockquote class="reply-to">
          <p class="meta"><span class="speaker">{props.replyTo.speaker}</span><time>{props.replyTo.at}</time></p>
          <p class="text">{props.replyTo.text}</p>
        </blockquote>
      )}
      {props.mode === 'editing'
        ? <textarea ref={draft} class="draft" rows={4} aria-label="送る本文" defaultValue={props.text} />
        : <p class="draft text">{props.text}</p>}
      {props.images.length > 0 && <Images images={props.images} />}
      {props.flagged.length > 0 && <ul class="flags">{props.flagged.map(label => <li key={label}>{label}</li>)}</ul>}
      {props.history.length > 0 && (
        <details class="history">
          <summary>前に突き返された下書き（{props.history.length}）</summary>
          <ol>{props.history.map((text, index) => <li key={index}>{text}</li>)}</ol>
        </details>
      )}
      {props.placement && (
        <label class="placement">
          置き場所
          <select ref={placement} disabled={props.mode === 'confirming' || props.mode === 'sending'}>
            {props.placement.options.map(option => (
              <option key={option.value} value={option.value} selected={option.value === props.placement!.selected}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
      {props.error && <p class="error" role="alert">{props.error}</p>}
      {props.mode === 'confirming' && props.confirm && (
        <div class="confirm" role="alertdialog" aria-label="確認">
          <p class="question">{props.confirm.question}</p>
          {props.confirm.text !== undefined && <blockquote class="text">{props.confirm.text}</blockquote>}
          <div class="actions">
            <button type="button" class={props.confirm.danger ? 'danger' : 'primary'} onClick={() => dispatch({ type: 'approval-confirm', approvalId })}>
              {props.confirm.confirmLabel}
            </button>
            <button type="button" onClick={() => dispatch({ type: 'approval-cancel', approvalId })}>{props.confirm.cancelLabel}</button>
          </div>
        </div>
      )}
      {props.mode === 'sending' && <p class="note">送っています…</p>}
      {props.mode === 'idle' && (
        <div class="actions">
          <button type="button" class="primary" onClick={() => choose('approve')}>承認…</button>
          <button type="button" onClick={() => dispatch({ type: 'approval-edit', approvalId })}>直す</button>
          <button type="button" class="danger" onClick={() => choose('reject')}>却下…</button>
        </div>
      )}
      {props.mode === 'editing' && (
        <div class="actions">
          <button type="button" class="primary" onClick={() => choose('edit')}>この本文で送る…</button>
          <button type="button" onClick={() => dispatch({ type: 'approval-cancel', approvalId })}>やめる</button>
        </div>
      )}
    </article>
  );
}
