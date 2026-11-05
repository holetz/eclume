// The Record button's flow, which the launcher icon's record-now shortcut also uses: the
// permissions, the battery explanation before the first recording without the exemption, and
// `record`, which only confirms after the microphone service enters the foreground. The screen (Home)
// shows what the flow asks for.

import { t } from '../i18n'
import { errorMessage, type Bridge } from '../bridge/bridge'
import type { DeviceStatus } from '../bridge/types'

/** What the flow asks of the screen after a step. */
export type RecordStep =
  | { step: 'recording' }
  | { step: 'no_microphone'; message: string }
  | { step: 'explain_battery' }
  | { step: 'error'; message: string }

/**
 * Asks for the microphone and the notifications; without the microphone, stops; before the first
 * recording without the battery exemption, asks for the explanation; otherwise, records.
 * `onPermit` receives what the system granted.
 */
export async function record(
  bridge: Bridge,
  device: DeviceStatus | null,
  onPermit?: (notifications: boolean) => void,
): Promise<RecordStep> {
  try {
    const granted = await bridge.permissions()
    onPermit?.(granted.notifications)
    if (!granted.microphone) return { step: 'no_microphone', message: t('home.noMicrophone') }
    if (device?.batteryExemption === 'pedir') return { step: 'explain_battery' }
    await bridge.record()
    return { step: 'recording' }
  } catch (e) {
    return { step: 'error', message: errorMessage(e) }
  }
}

/** After the battery explanation: asks for the exemption (with `ask`), rereads the device and records. */
export async function recordAfterBattery(
  bridge: Bridge,
  ask: boolean,
): Promise<{ step: RecordStep; device: DeviceStatus | null }> {
  let device: DeviceStatus | null = null
  try {
    if (ask) await bridge.requestBatteryExemption()
    device = await bridge.device()
    await bridge.record()
    return { step: { step: 'recording' }, device }
  } catch (e) {
    return { step: { step: 'error', message: errorMessage(e) }, device }
  }
}
