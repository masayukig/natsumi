import type { ScreenProps } from '../core/props.ts';
import { Chat } from './Chat.tsx';
import { Status, type Dispatch } from './parts.tsx';
import { Settings } from './Settings.tsx';

/**
 * The page (ADR 0058): a head with her face and name, the state of the connection, and the ways to the other pages,
 * over the screen the path chose. Every component here draws the props it is given and hands the owner's doings back
 * as events; none keeps state (mac/CLAUDE.md's passive view).
 */

export function App({ props, dispatch }: { props: ScreenProps; dispatch: Dispatch }) {
  return (
    <div class="page">
      <Head props={props} dispatch={dispatch} />
      {props.screen === 'chat' ? <Chat props={props} dispatch={dispatch} /> : <Settings props={props} dispatch={dispatch} />}
    </div>
  );
}

function Head({ props, dispatch }: { props: ScreenProps; dispatch: Dispatch }) {
  return (
    <header class="head">
      <div class="who">
        {props.face ? <img class="face" src={props.face} alt="" width={40} height={40} /> : <span class="face blank" aria-hidden="true" />}
        <div class="who-text">
          <h1 class="name">{props.name}</h1>
          <Status status={props.status} />
        </div>
        {props.reconnect && <button type="button" class="small" onClick={() => dispatch({ type: 'reconnect-now' })}>{props.reconnect.label}</button>}
      </div>
      <nav class="nav" aria-label="ページ">
        <a href="/" aria-current={props.screen === 'chat' ? 'page' : undefined}>チャット</a>
        <a href="/settings" aria-current={props.screen === 'settings' ? 'page' : undefined}>設定</a>
        <a href="/dashboard">ダッシュボード</a>
        <form method="post" action="/dashboard/logout" class="logout">
          <button type="submit" class="link">ログアウト</button>
        </form>
      </nav>
    </header>
  );
}
