import { vi } from 'vitest'

// Fixtures carry fixed 2026 timestamps; pin the clock so the retention window (default 12 months)
// doesn't start dropping them as real time passes. Only Date is faked; timers still run.
vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
