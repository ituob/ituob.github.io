module Jekyll
  module ITUDateFormatting
    def as_swiss_date(date)
      roman_months = {
        1 => "I",
        2 => "II",
        3 => "III",
        4 => "IV",
        5 => "V",
        6 => "VI",
        7 => "VII",
        8 => "VIII",
        9 => "IX",
        10 => "X",
        11 => "XI",
        12 => "XII",
      }
      begin
        "#{date.day}.#{roman_months[date.mon]}.#{date.year}"
      rescue
        date
      end
    end
  end
end

Liquid::Template.register_filter(Jekyll::ITUDateFormatting)
