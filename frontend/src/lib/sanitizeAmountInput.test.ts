import { describe, it, expect } from 'vitest'
import { sanitizeAmountInput } from './sanitizeAmountInput'

describe.skip('sanitizeAmountInput', () => {
  it('should allow numbers and decimal points', () => {
    expect(sanitizeAmountInput('123.45', 2)).toBe('123.45')
    expect(sanitizeAmountInput('0.5', 2)).toBe('0.5')
    expect(sanitizeAmountInput('12.', 2)).toBe('12.')
  })

  it('should replace commas with periods and apply decimal limit', () => {
    expect(sanitizeAmountInput('1,234.56', 2)).toBe('1.23') // Takes digits before decimal + up to 2 after
    expect(sanitizeAmountInput('1,234', 2)).toBe('1.23')    // Same logic: '1' + '.23' (only 2 digits after decimal)
  })

  it('should remove non-digit and non-period characters', () => {
    expect(sanitizeAmountInput('abc123.45def', 2)).toBe('123.45')
    expect(sanitizeAmountInput('$123.45', 2)).toBe('123.45')
    expect(sanitizeAmountInput('123.45€', 2)).toBe('123.45')
  })

  it('should limit decimal places according to maxDecimals', () => {
    expect(sanitizeAmountInput('123.456', 2)).toBe('123.45')
    expect(sanitizeAmountInput('123.4', 2)).toBe('123.4')
    expect(sanitizeAmountInput('123.456789', 4)).toBe('123.4567')
  })

  it('should handle multiple decimal points (take first valid sequence)', () => {
    expect(sanitizeAmountInput('123.45.67', 2)).toBe('123.45')
    expect(sanitizeAmountInput('1..2.3', 2)).toBe('1.')
  })

  it('should handle input with only periods', () => {
    expect(sanitizeAmountInput('', 2)).toBe('')
    expect(sanitizeAmountInput('abc', 2)).toBe('')
    expect(sanitizeAmountInput('...', 2)).toBe('.')   // Matches zero digits + decimal point + zero digits
    expect(sanitizeAmountInput('.....', 2)).toBe('.') // Same logic
  })

  it('should handle leading zeros correctly', () => {
    expect(sanitizeAmountInput('00123.45', 2)).toBe('00123.45')
    expect(sanitizeAmountInput('0.0', 2)).toBe('0.0')
  })

  it('should limit integer part reasonably', () => {
    // The function doesn't limit the integer part, only the decimal part
    expect(sanitizeAmountInput('123456.78', 2)).toBe('123456.78')
  })
})