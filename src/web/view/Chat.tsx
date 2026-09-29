import { useEffect, useRef } from 'preact/hooks';
import type { ChatProps, RowProps } from '../core/props.ts';
import { ApprovalCard } from './Approval.tsx';
import { Images, type Dispatch } from './parts.tsx';

/**
 * The chat (`/`): the approvals waiting, above the conversation so that her newest line stays in sight at the bottom,
 * with a link to them at the top; then the conversation and the field to write in.
 */
export function Chat({ props, dispatch }: { props: ChatProps; dispatch: Dispatch }) {
  const log = useRef<HTMLDivElement>(null);
  // The newest line is kept in sight as lines come: a scroll of the DOM, not state.
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [props.rows.length, props.outbox.length, props.thinking]);

  return (
    <main class="chat">
      {props.approvals.length > 0 && <a class="pending-chip" href="#approvals">承認待ち {props.approvals.length} 件</a>}
      <div class="log" ref={log} aria-live="polite">
        {props.approvals.length > 0 && (
          <section class="approvals" id="approvals" aria-label="承認待ち">
            <h2>承認待ち（{props.approvals.length}）</h2>
            {props.approvals.map(approval => <ApprovalCard key={approval.id} props={approval} dispatch={dispatch} />)}
          </section>
        )}
        {props.rows.map(row => <Row key={row.id} row={row} dispatch={dispatch} />)}
        {props.outbox.map(item => (
          <article key={item.requestId} class={`row owner outgoing${item.failed ? ' failed' : ''}`}>
            <div class="bubble">
              <p class="text">{item.text}</p>
              <p class="note">{item.note}</p>
              {item.failed && (
                <div class="actions">
                  <button type="button" class="small" onClick={() => dispatch({ type: 'retry-send', requestId: item.requestId })}>もう一度送る</button>
                  <button type="button" class="small quiet" onClick={() => dispatch({ type: 'dismiss-send', requestId: item.requestId })}>取り消す</button>
                </div>
              )}
            </div>
          </article>
        ))}
        {props.thinking && <p class="thinking" aria-label="考えている 1 行">{props.thinking}</p>}
        {props.results.map((result, index) => <p key={index} class="result">{result}</p>)}
      </div>
      <Composer placeholder={props.composer.placeholder} sentCount={props.composer.sentCount} dispatch={dispatch} />
    </main>
  );
}

function Row({ row, dispatch }: { row: RowProps; dispatch: Dispatch }) {
  return (
    <article class={`row ${row.side}${row.unread ? ' unread' : ''}${row.label ? ' notice' : ''}`} data-message-id={row.id}>
      {row.side === 'natsumi' && (row.face ? <img class="face" src={row.face} alt="" width={36} height={36} /> : <span class="face blank" aria-hidden="true" />)}
      <div class="bubble">
        <p class="meta">
          <span class="speaker">{row.speaker}</span>
          {row.label && <span class="label">{row.label}</span>}
          <time>{row.time}</time>
        </p>
        <p class="text">{row.text}</p>
        {row.images.length > 0 && <Images images={row.images} />}
        {row.ack && (
          <div class="actions">
            <button type="button" class="small" onClick={() => dispatch({ type: 'ack-notice', notificationId: row.ack!.notificationId })}>{row.ack.label}</button>
          </div>
        )}
      </div>
    </article>
  );
}

/** Enter sends on a keyboard with a pointer; on a touch screen it is a new line, and the button sends. */
const enterSends = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

function Composer({ placeholder, sentCount, dispatch }: { placeholder: string; sentCount: number; dispatch: Dispatch }) {
  const field = useRef<HTMLTextAreaElement>(null);
  // The draft is the field's own until it is sent; a new count says it went, so the field is emptied.
  useEffect(() => { if (sentCount > 0 && field.current) field.current.value = ''; }, [sentCount]);
  const send = () => dispatch({ type: 'send', text: field.current?.value ?? '' });
  return (
    <form class="composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <textarea ref={field} name="text" rows={2} placeholder={placeholder} aria-label="メッセージ" enterkeyhint="send"
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && enterSends()) { event.preventDefault(); send(); }
        }} />
      <button type="submit" class="primary">送る</button>
    </form>
  );
}
