module Jekyll

  # Localizes a template variable the value of which is an object (hash)
  # containing translated strings under language keys.
  #
  #   { <language1>: <string>, <language2>: <string> }
  #
  # The target language for localization is taken from page’s `lang` variable.
  # If the translation for the target language is not specified,
  # `site.default_language` is used.
  #
  # Example:
  #
  #   ```
  #   ---
  #   lang: en
  #   hello:
  #     en: hello
  #     ja: こんにちは
  #   ---
  #
  #   {% trans page.hello %}
  #   ```
  #
  # (This example seems pretty useless, the mechanism is mostly intended to work with
  # page context populated automatically, not through manual data entry in frontmatter.)
  class LocalizeKey < Liquid::Tag

    def initialize(tag_name, key, tokens)
      super
      @key = key.strip
    end

    def render(context)
      translatable = context[@key]
      active_lang = context['page']['lang']
      default_lang = context['site']['default_language']

      if translatable
        result = translatable[active_lang] || translatable[default_lang] || translatable
      else
        result = translatable
      end

      result
    end

  end

  # Converts specified AsciiDoc file into HTML,
  # using path <OB issue path>/<page.lang>-<filename>,
  # falling back to <OB issue path>/<site.default_language>-<filename>,
  # falling back to <OB issue path>/<filename>.
  #
  # Localization behavior resembles the one of the {% trans %} tag.
  #
  # Currently, only AsciiDoc files are supported.
  #
  # Example:
  #
  #   ```
  #   ---
  #   lang: en
  #   file: iptn.adoc
  #   ---
  #
  #   {% trans_file page.file %}
  #   ```
  class LocalizeProcessFile < Liquid::Tag

    def initialize(tag_name, key, tokens)
      super
      @key = key.strip
    end

    def render(context)
      filename = context[@key]
      issue_path = File.join(
        context['site']['source'],
        context['site']['ob_root'],
        context['page']['issue']['meta']['id'].to_s)

      active_lang = context['page']['lang']
      default_lang = context['site']['default_language']

      fpath_candidates = [
        File.join(issue_path, "#{active_lang}-#{filename}"),
        File.join(issue_path, "#{default_lang}-#{filename}"),
        File.join(issue_path, filename),
      ]

      result = nil

      fpath_candidates.each do |fpath|
        if File.file?(fpath)
          contents = File.read(fpath)
          result = Asciidoctor.convert contents, safe: :server
          break
        end
      end

      if result == nil
        p "Couldn’t translate referenced file: #{filename}"
      end

      result
    end

  end
end

Liquid::Template.register_tag('trans', Jekyll::LocalizeKey)
Liquid::Template.register_tag('trans_file', Jekyll::LocalizeProcessFile)
