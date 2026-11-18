#!/usr/bin/env ruby
# frozen_string_literal: true

# Independent check of per-item history (D107-3).
#
# Builds the expected history of every register item straight from the printed
# change files (<projection>/ob-issues/<issue>/<register>/NNN-TYPE.yaml, one per
# change printed in a bulletin) and compares it with key_history in the register
# snapshot (data/snapshots/<slug>/current.json), which is exactly what the item
# page renders (src/pages/registers/[slug]/items/[key]).
#
#   ruby scripts/compare-item-history.rb <projection-root> <snapshots-root> [slug ...]
#   ITEMS="e212-mnc|216 04,e212-mnc|639 08" ruby ... prints per-item expected vs rendered
#
# Prints a per-register summary and, for each mismatch, a classified sample.
# Exit status 1 when any mismatch exists.

require "yaml"
require "json"
require "date"

LANGS = %w[fr en es zh ru ar].freeze

def key_part(value)
  case value
  when nil then ""
  when Hash
    lang = LANGS.find { |l| value[l].is_a?(String) && value[l] != "" }
    lang ? value[lang].to_s : ""
  else value.to_s
  end
end

def entry_key(entry, key_field)
  parts = Array(key_field).map { |f| key_part(entry[f]) }
  parts.all?(&:empty?) ? nil : parts.join(" | ")
end

def load_yaml(path)
  YAML.safe_load(File.read(path), permitted_classes: [Date, Time, Symbol], aliases: true)
end

projection, snapshots, *slugs = ARGV
abort "usage: compare-item-history.rb <projection-root> <snapshots-root> [slug...]" unless projection && snapshots

slugs = Dir.children(snapshots).select { |s| File.exist?(File.join(snapshots, s, "current.json")) }.sort if slugs.empty?
wanted = (ENV["ITEMS"] || "").split(",").map { |s| s.split("|", 2).then { |a, b| [a, b] } }
bad = 0

# Events a printed file routes to a sibling register (e.g. 901 xx printed in the
# e212-mnc directory but replayed into e212-shared-mcc) are not mismatches.
all_actual = Hash.new { |h, k| h[k] = [] }
Dir.children(snapshots).each do |other|
  f = File.join(snapshots, other, "current.json")
  next unless File.exist?(f)

  (JSON.parse(File.read(f))["key_history"] || {}).each do |k, evs|
    evs.each { |e| all_actual[k] << [e["type"], e["ob_issue"]] unless e["type"] == "SEED" }
  end
end

slugs.each do |slug|
  manifest = JSON.parse(File.read(File.join(snapshots, slug, "manifest.json")))
  state = JSON.parse(File.read(File.join(snapshots, slug, "current.json")))
  seed = manifest["seed_issue"]
  khist = state["key_history"] || {}
  expected = Hash.new { |h, k| h[k] = [] }
  Dir.glob(File.join(projection, "ob-issues", "*", slug, "[0-9]*-*.yaml")).sort_by do |f|
    [f.split("/")[-3].to_i, File.basename(f)]
  end.each do |file|
    issue = file.split("/")[-3].to_i
    doc = load_yaml(file)
    next unless doc.is_a?(Hash) && doc["data"].is_a?(Hash)

    (doc["data"]["entries"] || []).each do |entry|
      key = entry_key(entry, manifest["key_field"])
      expected[key] << [doc["type"], issue] if key
    end
  end

  actual = khist.transform_values { |evs| evs.reject { |e| e["type"] == "SEED" }.map { |e| [e["type"], e["ob_issue"]] } }
  missing = Hash.new { |h, k| h[k] = [] }
  order_bad = []
  extra = {}
  expected.each do |key, evs|
    got = actual[key] || []
    # multiset difference, keeping print order
    pool = got.dup
    evs.each do |ev|
      if (i = pool.index(ev)) then pool.delete_at(i)
      elsif !all_actual[key].include?(ev) then missing[key] << ev
      end
    end
    extra[key] = pool unless pool.empty?
  end
  actual.each do |key, evs|
    order_bad << key unless evs.map(&:last).each_cons(2).all? { |a, b| a <= b }
    extra[key] = evs if !expected.key?(key) && !evs.empty?
  end
  # "pre" = printed in a bulletin older than the seed issue (the seed list
  # already embodies it, so replay never touches the key).
  pre = ->(evs) { evs.all? { |_, i| seed && i < seed } }
  miss_pre = missing.select { |_, evs| pre.(evs) }
  miss_post = missing.reject { |_, evs| pre.(evs) }.transform_values { |evs| evs.reject { |_, i| seed && i < seed } }
  puts format("%-16s items=%d printed-keys=%d missing(pre-seed)=%d missing(post-seed)=%d extra=%d out-of-order=%d",
              slug, khist.size, expected.size, miss_pre.size, miss_post.size, extra.size, order_bad.size)
  bad += miss_post.size + extra.size + order_bad.size
  miss_post.first(5).each { |k, evs| puts "  MISSING #{k.inspect}: printed-only #{evs.inspect} rendered=#{actual[k].inspect}" }
  extra.first(5).each { |k, evs| puts "  EXTRA   #{k.inspect}: rendered-only #{evs.inspect} printed=#{expected[k].inspect}" }
  order_bad.first(3).each { |k| puts "  ORDER   #{k.inspect}: #{actual[k].inspect}" }
  wanted.select { |s, _| s == slug }.each do |_, key|
    puts "  ITEM #{slug} #{key.inspect}"
    puts "    printed (non-seed): #{expected[key].inspect}"
    puts "    rendered          : #{(khist[key] || []).map { |e| [e['type'], e['ob_issue']] }.inspect}"
    puts "    verdict           : #{expected[key] == actual[key] ? 'MATCH' : 'MISMATCH'}"
  end
end
exit(bad.zero? ? 0 : 1)
