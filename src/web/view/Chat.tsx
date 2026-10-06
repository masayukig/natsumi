import { useEffect, useRef } from 'preact/hooks';
import type { AttachmentProps, ChatProps, ComposerProps, FileProps, RowProps } from '../core/props.ts';
import { ApprovalCard } from './Approval.tsx';
import { Images, type Dispatch } from './parts.tsx';

/** The files a drop, a paste or the picker hands over, as the core takes them. */
const filesOf = (list: FileList | null | undefined): File[] => (list ? Array.from(list) : []);

/**
 * The chat (`/`): the approvals waiting, above the conversation so that her newest line stays in sight at the bottom,
 * with a link to them at the top; then the conversation and the field to write in. A file dropped anywhere on it is
 * attached to the message being written (ADR 0071).
 */
export function Chat({ props, dispatch }: { props: ChatProps; dispatch: Dispatch }) {
  const log = useRef<HTMLDivElement>(null);
  // The newest line is kept in sight as lines come: a scroll of the DOM, not state.
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [props.rows.length, props.outbox.length, props.thinking]);

  return (
    <main class="chat"
      onDragOver={event => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        event.currentTarget.classList.add('dropping');
      }}
      onDragLeave={event => { if (event.currentTarget === event.target) event.currentTarget.classList.remove('dropping'); }}
      onDrop={event => {
        event.currentTarget.classList.remove('dropping');
        const files = filesOf(event.dataTransfer?.files);
        if (files.length === 0) return;
        event.preventDefault();
        dispatch({ type: 'attach', files });
      }}>
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
              {item.text !== '' && <p class="text">{item.text}</p>}
              {item.files.length > 0 && <ul class="files">{item.files.map((name, index) => <li key={index} class="file">{name}</li>)}</ul>}
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
      <Composer props={props.composer} dispatch={dispatch} />
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
        {row.text !== '' && <p class="text">{row.text}</p>}
        {row.images.length > 0 && <Images images={row.images} />}
        {row.files.length > 0 && <Files files={row.files} />}
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

/** A file a message carried, by name and size, which downloads when followed. */
function Files({ files }: { files: FileProps[] }) {
  return (
    <ul class="files">
      {files.map((file, index) => <li key={index} class="file"><a href={file.href} download={file.name}>{file.name}</a> <span class="size">{file.size}</span></li>)}
    </ul>
  );
}

function Composer({ props, dispatch }: { props: ComposerProps; dispatch: Dispatch }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // The draft is the field's own until it is sent; a new count says it went, so the field is emptied.
  useEffect(() => { if (props.sentCount > 0 && field.current) field.current.value = ''; }, [props.sentCount]);
  const send = () => dispatch({ type: 'send', text: field.current?.value ?? '' });
  return (
    <form class="composer" onSubmit={event => { event.preventDefault(); send(); }}>
      {props.attachments.length > 0 && (
        <ul class="chips" aria-label="添えるファイル">
          {props.attachments.map(chip => <Chip key={chip.localId} chip={chip} dispatch={dispatch} />)}
        </ul>
      )}
      {props.note && <p class="note composer-note" role="status">{props.note}</p>}
      <div class="composer-row">
        <input ref={picker} type="file" multiple hidden aria-hidden="true" tabIndex={-1}
          onChange={event => {
            const files = filesOf(event.currentTarget.files);
            // Emptied, so the same file can be chosen again after it was taken back.
            event.currentTarget.value = '';
            if (files.length > 0) dispatch({ type: 'attach', files });
          }} />
        <button type="button" class="attach" aria-label={props.attachLabel} title={props.attachLabel} onClick={() => picker.current?.click()}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></svg>
        </button>
        <textarea ref={field} name="text" rows={2} placeholder={props.placeholder} aria-label="メッセージ" enterkeyhint="send"
          onPaste={event => {
            // A picture or a file pasted is attached; pasted text goes into the field as ever.
            const files = filesOf(event.clipboardData?.files);
            if (files.length === 0) return;
            event.preventDefault();
            dispatch({ type: 'attach', files });
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && enterSends()) { event.preventDefault(); send(); }
          }} />
        <button type="submit" class="primary">送る</button>
      </div>
    </form>
  );
}

function Chip({ chip, dispatch }: { chip: AttachmentProps; dispatch: Dispatch }) {
  return (
    <li class={`chip ${chip.state}`}>
      {chip.preview ? <img class="thumb" src={chip.preview} alt="" width={40} height={40} /> : <span class="thumb blank" aria-hidden="true" />}
      <span class="chip-text">
        <span class="chip-name">{chip.name}</span>
        <span class="chip-size">{chip.state === 'uploading' ? `${chip.size}・上げています…` : chip.size}</span>
        {chip.note && <span class="chip-note">{chip.note}</span>}
      </span>
      <button type="button" class="remove" aria-label={chip.removeLabel} title={chip.removeLabel}
        onClick={() => dispatch({ type: 'remove-attachment', localId: chip.localId })}>×</button>
    </li>
  );
}
