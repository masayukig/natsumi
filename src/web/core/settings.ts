import {
  awakeHoursProblem, checkSetting, MIN_PING_INTERVAL_MINUTES, type SettingKey, type SettingValues,
} from '../../shared/protocol/settings.ts';

/**
 * A setting's input as the form hands it over, and its check by the contract's rules (the same the server and the
 * config keep) before anything is sent, with the words for what is wrong.
 */

export type LimitKey = 'eventModelCalls' | 'eventTimeoutMinutes' | 'reviewModelCalls' | 'reviewTimeoutMinutes' | 'curatorModelCalls' | 'curatorTimeoutMinutes';
export const LIMIT_KEYS: readonly LimitKey[] = ['eventModelCalls', 'eventTimeoutMinutes', 'reviewModelCalls', 'reviewTimeoutMinutes',
  'curatorModelCalls', 'curatorTimeoutMinutes'];
export const isLimitKey = (key: SettingKey): key is LimitKey => (LIMIT_KEYS as readonly string[]).includes(key);

export type SettingInput =
  | { key: 'modelRoute'; route: string }
  /** The curator's route: a route's name, or empty for natsumi's (ADR 0068). */
  | { key: 'curatorRoute'; route: string }
  | { key: 'turnFold'; fold: string }
  | { key: LimitKey; text: string }
  | { key: 'awakeHours'; start: string; end: string }
  | { key: 'pingIntervalMinutes'; text: string; off: boolean }
  | { key: 'judgeLogprobs' | 'judgeJev' | 'judgeAdopted'; choice: string }
  | { key: 'judgeLogprobsThresholds' | 'judgeJevThresholds'; owner: string; return: string };

export type ParsedSetting =
  | { [K in SettingKey]: { ok: true; key: K; value: SettingValues[K] } }[SettingKey]
  | { ok: false; key: SettingKey; message: string };

/** A whole number as typed: digits only, so `1.5`, `1e3` and blanks are not taken for one. */
const wholeNumber = (text: string): number | undefined => (/^\s*\d+\s*$/.test(text) ? Number(text) : undefined);
/** A decimal as typed, such as `0.5` or `1`: digits and one point, so blanks and `1e-1` are not taken for one. */
const decimal = (text: string): number | undefined => (/^\s*\d+(\.\d+)?\s*$/.test(text) ? Number(text) : undefined);

export function parseSettingInput(input: SettingInput): ParsedSetting {
  const wrong = (message: string): ParsedSetting => ({ ok: false, key: input.key, message });
  const checked = (value: unknown): ParsedSetting | undefined => {
    const result = checkSetting(input.key, value);
    return result.ok ? result : undefined;
  };
  switch (input.key) {
    case 'modelRoute':
      return checked(input.route) ?? wrong('経路を選んでください。');
    case 'curatorRoute':
      return checked(input.route === '' ? null : input.route) ?? wrong('経路を選んでください。');
    case 'turnFold':
      return checked(input.fold) ?? wrong('on か off を選んでください。');
    case 'judgeLogprobs': case 'judgeJev':
      return checked(input.choice) ?? wrong('on か off を選んでください。');
    case 'judgeAdopted':
      return checked(input.choice) ?? wrong('logprobs か jev を選んでください。');
    case 'judgeLogprobsThresholds': case 'judgeJevThresholds':
      return checked({ owner: decimal(input.owner), return: decimal(input.return) })
        ?? wrong('どちらも 0 より大きく 1 以下の数で、本人へ回すほうを突き返すほう以下にしてください。');
    case 'awakeHours': {
      const value = { start: input.start, end: input.end };
      const problem = awakeHoursProblem(value);
      if (!problem) return checked(value)!;
      if (problem.part === 'end' && 'reason' in problem && problem.reason === 'same-as-start') return wrong('始まりと終わりを同じ時刻にはできません。');
      return wrong(problem.part === 'start' ? '始まりを HH:MM で入れてください。' : '終わりを HH:MM で入れてください。');
    }
    case 'pingIntervalMinutes':
      if (input.off) return checked(false)!;
      return checked(wholeNumber(input.text)) ?? wrong(`${MIN_PING_INTERVAL_MINUTES} 以上の整数（分）を入れるか、「合図しない」を選んでください。`);
    default:
      return checked(wholeNumber(input.text)) ?? wrong('1 以上の整数を入れてください。');
  }
}
