# frozen_string_literal: true

require "cgi"
require "pathname"
require "set"

site_dir = Pathname("_site")
abort "_site does not exist. Run `bundle exec jekyll build` first." unless site_dir.directory?

html_files = Dir.glob(site_dir.join("**/*.html").to_s).map { |path| Pathname(path) }
missing = Set.new
externally_served_prefixes = ["/resume/"]

html_files.each do |file|
  html = file.read(encoding: "UTF-8")

  html.scan(/href=["']([^"']+)["']/i).flatten.each do |href|
    next if href.empty?
    next if href.start_with?("#", "http://", "https://", "mailto:", "tel:", "javascript:", "//")
    next unless href.start_with?("/")

    path = href.split("#", 2).first.split("?", 2).first
    next if externally_served_prefixes.any? { |prefix| path.start_with?(prefix) }

    path = CGI.unescape(path)
    relative_path = path.delete_prefix("/")
    target = site_dir.join(relative_path)
    candidates = [target, target.join("index.html")]
    candidates << site_dir.join("#{relative_path}.html") if File.extname(relative_path).empty?

    next if candidates.any?(&:file?)

    missing << "#{file}: #{href}"
  end
end

if missing.any?
  warn "Missing internal links:"
  missing.sort.each { |item| warn "  #{item}" }
  exit 1
end

puts "Internal links look good."
