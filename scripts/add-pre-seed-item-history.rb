#!/usr/bin/env ruby
# frozen_string_literal: true

# Add the printed changes that replay never applies to each item's history.
#
# A register replays from its seed list, so every amendment printed before the
# seed issue is skipped (the seed already embodies it), and a change printed in
# the seed issue itself can be reflected in the seed without being recorded.
# The bulletins still printed those changes, and an item's history page must show
# every printed change to that item, in order. This step reads the same change
# files replay reads and merges the missing events into key_history of every
# snapshot, for keys that already have an item page only (it never creates a new
# item). The flat `history` list is left alone: it is the register-level replay log.
#
#   ruby scripts/add-pre-seed-item-history.rb <snapshots-dir>
#
# Run from the pinned service overlay under `bundle exec` (see
# project-authored-data.py); needs the service's ituob library.

require "json"
require "ituob"
require "ituob/support"
require "ituob/registers"
require "ituob/catalogs"
require "ituob/verifiers"

# Merge +missing+ (ascending issue, print order) into +existing+ so the result
# stays ordered by OB issue; on a tie the printed-earlier event comes first.
def merge_events(existing, missing)
  pending = missing.dup
  merged = []
  existing.each do |event|
    merged << pending.shift while pending.first && event["ob_issue"] && pending.first["ob_issue"] <= event["ob_issue"]
    merged << event
  end
  merged.concat(pending)
end

# Keys a change touches, exactly as replay derives them.
def change_keys(change, key_field, fallbacks)
  rows = Ituob::Registers::Strategies::Base.rows_for(change, key_field, fallbacks)
  if rows.empty?
    return change.identifier.direct? && change.identifier.code ? [change.identifier.code.to_s] : []
  end

  rows.map { |row| Ituob::Registers::Strategies::Base.entry_key(row, key_field, fallbacks) }.compact
end

# { key => [event, ...] } for every change printed at or before the seed issue
# (seed list rows excluded), in print order.
def printed_before_or_at_seed(entry, replay)
  source = replay.source
  seed = source.seed_issue
  return {} unless seed

  changes = source.pre_seed_changes + source.each_sorted.reject(&:seed?).select { |c| c.ob_issue_no == seed }
  fallbacks = Array(entry.fallback_key_fields)
  changes.each_with_object(Hash.new { |h, k| h[k] = [] }) do |change, events|
    event = { "type" => change.type, "ob_issue" => change.ob_issue_no, "identifier" => change.identifier.to_hash }
    change_keys(change, entry.key_field, fallbacks).each { |key| events[key] << event }
  end
end

def missing_events(printed, existing)
  pool = existing.map { |e| [e["type"], e["ob_issue"]] }
  printed.reject do |event|
    (i = pool.index([event["type"], event["ob_issue"]])) && pool.delete_at(i)
  end
end

root = ARGV.fetch(0) { abort "usage: add-pre-seed-item-history.rb <snapshots-dir>" }
added = 0
Ituob::Catalogs::Registers.all_register_ids.each do |register_id|
  entry = Ituob::Catalogs::Registers.find(register_id)
  replay = Ituob::Verifiers::RegisterStateIntegrityVerifier.build_replay(entry)
  next unless replay

  dir = File.join(root, entry.slug)
  next unless Dir.exist?(dir)

  printed = printed_before_or_at_seed(entry, replay)
  Dir.glob(File.join(dir, "{current,at-*}.json")).each do |path|
    state = JSON.parse(File.read(path))
    history = state["key_history"]
    next unless history.is_a?(Hash)

    changed = false
    history.each do |key, events|
      missing = missing_events(printed.fetch(key, []), events)
      next if missing.empty?

      history[key] = merge_events(events, missing)
      added += missing.length if File.basename(path) == "current.json"
      changed = true
    end
    File.write(path, JSON.pretty_generate(state)) if changed
  end
end
puts "Item history: #{added} printed pre-seed events added to existing items"
