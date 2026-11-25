-- KEYS: tickets, pops, serving      ARGV: user, window
-- Returns {'none'} or {state, ticket, serving, windowEnd}
local tickets_key, pops_key, serving_key = KEYS[1], KEYS[2], KEYS[3]
local user, window_ms = ARGV[1], tonumber(ARGV[2])

local now = now_ms()
local state, window_end = admission(tickets_key, pops_key, user, now, window_ms)
if state == 'none' then return {'none'} end
local ticket = tonumber(redis.call('HGET', tickets_key, user))
local serving = tonumber(redis.call('GET', serving_key)) or 0
return {state, ticket, serving, window_end}
