import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketOf, parseSince, percent, table } from '../src/node/metrics.ts'

test('the time window is a count of minutes, hours or days', () => {
  assert.equal(parseSince('30m'), 30 * 60_000)
  assert.equal(parseSince('3h'), 3 * 3_600_000)
  assert.equal(parseSince('2d'), 2 * 86_400_000)
  for (const text of ['0h', '3', 'h', '1w', '-1h']) assert.throws(() => parseSince(text), /not a time like 30m, 3h or 2d/)
})

test('a longer window gets larger buckets', () => {
  assert.equal(bucketOf(parseSince('1h')).field, 'datetimeMinute')
  assert.equal(bucketOf(parseSince('2h')).field, 'datetimeMinute')
  assert.equal(bucketOf(parseSince('3h')).field, 'datetimeFiveMinutes')
  assert.equal(bucketOf(parseSince('3d')).field, 'datetimeHour')
})

test('CPU is a percent of the allocated vCPU, and can go over 100%', () => {
  assert.equal(percent(0.815), '82%')
  assert.equal(percent(1.8364), '184%')
})

test('the table pads each column to its widest cell', () => {
  assert.equal(
    table([
      ['container', 'cpu'],
      ['acme/app#7', '95%'],
    ]),
    'container   cpu\nacme/app#7  95%',
  )
})
