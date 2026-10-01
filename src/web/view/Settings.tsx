import type { SettingInput } from '../core/settings.ts';
import type { SettingRowProps, SettingsProps } from '../core/props.ts';
import type { Dispatch } from './parts.tsx';

/**
 * The settings (`/settings`): each setting natsumi can change while she runs, with the config's value beside the one
 * in force. The form hands its fields back as they are typed; the core checks them.
 */
export function Settings({ props, dispatch }: { props: SettingsProps; dispatch: Dispatch }) {
  return (
    <main class="settings">
      <Notifications notifications={props.notifications} dispatch={dispatch} />
      <p class="intro">ここで変えた値は、サーバーの config の上書きとして残ります。「config に戻す」で上書きを消します。</p>
      {props.rows.map(row => (
        // A new value from the server draws the fields afresh; while it stays, what the owner typed stays.
        <SettingRow key={`${row.key}:${JSON.stringify(row.control)}`} row={row} dispatch={dispatch} />
      ))}
    </main>
  );
}

/** This browser's notifications (ADR 0065): asked of the browser here, and kept by the browser, not the server's config. */
function Notifications({ notifications, dispatch }: { notifications: SettingsProps['notifications']; dispatch: Dispatch }) {
  const { status, error } = notifications;
  return (
    <section class="setting" aria-labelledby="notifications-label">
      <h2 id="notifications-label">このブラウザへの通知</h2>
      <p class="help">このブラウザでなつみを開いていない間の返事・知らせ・承認待ちを、通知で受け取ります。</p>
      {status === 'unsupported'
        ? <p class="note">このブラウザ、またはサーバーでは通知を使えません。</p>
        : (
          <button type="button" class={status === 'on' ? '' : 'primary'} disabled={status === 'busy'}
            onClick={() => dispatch({ type: 'push-toggle', on: status !== 'on' })}>
            {status === 'busy' ? '設定しています…' : status === 'on' ? '通知を止める' : '通知を受け取る'}
          </button>
        )}
      {error && <p class="error" role="alert">{error}</p>}
    </section>
  );
}

function inputOf(row: SettingRowProps, form: HTMLFormElement): SettingInput {
  const data = new FormData(form);
  const field = (name: string) => String(data.get(name) ?? '');
  switch (row.key) {
    case 'modelRoute': return { key: 'modelRoute', route: field('value') };
    case 'turnFold': return { key: 'turnFold', fold: field('value') };
    case 'awakeHours': return { key: 'awakeHours', start: field('start'), end: field('end') };
    case 'pingIntervalMinutes': return { key: 'pingIntervalMinutes', text: field('value'), off: data.get('off') === 'on' };
    case 'judgeLogprobs': case 'judgeJev': case 'judgeAdopted': return { key: row.key, choice: field('value') };
    case 'judgeLogprobsThresholds': case 'judgeJevThresholds': return { key: row.key, owner: field('owner'), return: field('return') };
    default: return { key: row.key, text: field('value') };
  }
}

function SettingRow({ row, dispatch }: { row: SettingRowProps; dispatch: Dispatch }) {
  const id = `setting-${row.key}`;
  return (
    <form class={`setting${row.overridden ? ' overridden' : ''}`} data-setting={row.key} aria-labelledby={`${id}-label`}
      onSubmit={event => { event.preventDefault(); dispatch({ type: 'setting-submit', input: inputOf(row, event.currentTarget) }); }}>
      <h2 id={`${id}-label`}>{row.label}</h2>
      <p class="help">{row.help}</p>
      <dl class="values">
        <div><dt>今の値</dt><dd class="value">{row.valueText}{row.overridden && <span class="badge">上書き中</span>}</dd></div>
        <div><dt>config の値</dt><dd class="config">{row.configText}</dd></div>
      </dl>
      {row.note && <p class="note next-turn">{row.note}</p>}
      <fieldset class="control" disabled={row.busy}>
        <Control row={row} id={id} />
        <div class="actions">
          <button type="submit" class="primary">{row.busy ? '変えています…' : '変える'}</button>
          {row.canReset && (
            <button type="button" onClick={() => dispatch({ type: 'setting-reset', key: row.key })}>config に戻す</button>
          )}
        </div>
      </fieldset>
      {row.error && <p class="error" role="alert">{row.error}</p>}
    </form>
  );
}

function Control({ row, id }: { row: SettingRowProps; id: string }) {
  const { control } = row;
  switch (control.kind) {
    case 'select':
      return (
        <label for={`${id}-value`} class="field">
          <span class="field-label">新しい値</span>
          <select id={`${id}-value`} name="value">
            {control.options.map(option => (
              <option key={option.value} value={option.value} disabled={option.disabled} selected={option.value === control.selected}>{option.label}</option>
            ))}
          </select>
        </label>
      );
    case 'number':
      return (
        <label for={`${id}-value`} class="field">
          <span class="field-label">新しい値（{control.unit}）</span>
          <input id={`${id}-value`} name="value" type="text" inputMode="numeric" defaultValue={control.value} />
        </label>
      );
    case 'hours':
      return (
        <div class="field hours">
          <label for={`${id}-start`}><span class="field-label">始まり</span><input id={`${id}-start`} name="start" type="time" defaultValue={control.start} /></label>
          <label for={`${id}-end`}><span class="field-label">終わり</span><input id={`${id}-end`} name="end" type="time" defaultValue={control.end} /></label>
        </div>
      );
    case 'thresholds':
      return (
        <div class="field hours">
          <label for={`${id}-owner`}><span class="field-label">本人へ回す</span>
            <input id={`${id}-owner`} name="owner" type="text" inputMode="decimal" defaultValue={control.owner} /></label>
          <label for={`${id}-return`}><span class="field-label">突き返す</span>
            <input id={`${id}-return`} name="return" type="text" inputMode="decimal" defaultValue={control.return} /></label>
        </div>
      );
    case 'ping':
      return (
        <div class="field ping">
          <label for={`${id}-value`}><span class="field-label">新しい値（分）</span>
            <input id={`${id}-value`} name="value" type="text" inputMode="numeric" defaultValue={control.value} /></label>
          <label class="check"><input name="off" type="checkbox" defaultChecked={control.off} /> 合図しない</label>
        </div>
      );
  }
}
