-- KEYS: ready, stock, last, serving, lastTick, pops
-- ARGV: saleStart, saleEnd, intervalMs, batchSize
-- Claims the current tick if nobody has, and pops up to batchSize users. Returns how many were popped.
local ready_key, stock_key, last_key, serving_key, last_tick_key, pops_key =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
local sale_start, sale_end = tonumber(ARGV[1]), tonumber(ARGV[2])
local interval_ms, batch_size = tonumber(ARGV[3]), tonumber(ARGV[4])

if not is_ready(ready_key) then return 0 end
local now = now_ms()
if not in_window(now, sale_start, sale_end) or not has_stock(stock_key) then return 0 end

-- A tick is one admit interval, counted from the sale start. Each tick is popped once: the first
-- call to see a new tick records it in last_tick, and every later call in that tick returns 0.
local tick = math.floor((now - sale_start) / interval_ms)
if tick <= (tonumber(redis.call('GET', last_tick_key)) or -1) then return 0 end
redis.call('SET', last_tick_key, tick)

local serving = tonumber(redis.call('GET', serving_key)) or 0
local last = tonumber(redis.call('GET', last_key)) or 0
local new_serving = math.min(serving + batch_size, last)
if new_serving > serving then
  redis.call('SET', serving_key, new_serving)
  redis.call('ZADD', pops_key, new_serving, now)
end
return new_serving - serving
