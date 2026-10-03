package stats

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
)

var (
	statsFileRE    = regexp.MustCompile(`^stats_\d{8}\.csv$`)
	tsumListFileRE = regexp.MustCompile(`^tsum_list_(\d{8}-\d{6})\.csv$`)
)

// The stats CSV's fixed columns; every other column is a setting the round was
// played under, and those grow over time, so they are kept as JSON.
var statsBaseColumns = map[string]bool{
	"id": true, "datetime": true, "script_version": true, "skill_type": true, "tsum": true, "build": true,
	"duration_seconds": true, "score": true, "base_coins": true, "final_coins": true, "medals": true,
}

func readCSV(r io.Reader) (header map[string]int, rows [][]string, err error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	all, err := cr.ReadAll()
	if err != nil {
		return nil, nil, err
	}
	if len(all) == 0 {
		return nil, nil, errors.New("empty file")
	}
	header = map[string]int{}
	for i, name := range all[0] {
		header[strings.TrimSpace(strings.TrimPrefix(name, "\xef\xbb\xbf"))] = i
	}
	return header, all[1:], nil
}

func cell(header map[string]int, row []string, name string) string {
	if i, ok := header[name]; ok && i < len(row) {
		return strings.TrimSpace(row[i])
	}
	return ""
}

func intCell(s string) *int64 {
	if s == "" {
		return nil
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return &n
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		n := int64(f)
		return &n
	}
	return nil
}

func floatCell(s string) *float64 {
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return &f
	}
	return nil
}

// settingValue turns a CSV cell back into the value the settings object held:
// switches are written T/F.
func settingValue(s string) any {
	switch s {
	case "T":
		return true
	case "F":
		return false
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f
	}
	return s
}

// parseStatsCSV reads a stats_YYYYMMDD.csv. Rows without an id or a readable
// datetime are skipped.
func parseStatsCSV(r io.Reader) ([]Round, error) {
	header, rows, err := readCSV(r)
	if err != nil {
		return nil, err
	}
	if _, ok := header["id"]; !ok {
		return nil, errors.New("not a stats CSV: no id column")
	}
	out := make([]Round, 0, len(rows))
	for _, row := range rows {
		id := cell(header, row, "id")
		at, ok := normalizeTime(cell(header, row, "datetime"))
		if id == "" || !ok {
			continue
		}
		settings := map[string]any{}
		for name, i := range header {
			if statsBaseColumns[name] || i >= len(row) || strings.TrimSpace(row[i]) == "" {
				continue
			}
			settings[name] = settingValue(strings.TrimSpace(row[i]))
		}
		js, _ := json.Marshal(settings)
		out = append(out, Round{
			ID:            id,
			PlayedAt:      at,
			Tsum:          cell(header, row, "tsum"),
			Build:         cell(header, row, "build"),
			SkillType:     cell(header, row, "skill_type"),
			ScriptVersion: cell(header, row, "script_version"),
			Duration:      floatCell(cell(header, row, "duration_seconds")),
			Score:         intCell(cell(header, row, "score")),
			BaseCoins:     intCell(cell(header, row, "base_coins")),
			FinalCoins:    intCell(cell(header, row, "final_coins")),
			Medals:        intCell(cell(header, row, "medals")),
			Settings:      string(js),
			Source:        SourceCSV,
		})
	}
	return out, nil
}

// parseTsumListCSV reads a tsum_list_<stamp>.csv. Exports older than the
// `build` column are told apart by their names: a JP list's are Japanese.
// Exports older than the `device` column have no device ("").
func parseTsumListCSV(r io.Reader) (build, device string, rows []OwnedTsum, err error) {
	header, records, err := readCSV(r)
	if err != nil {
		return "", "", nil, err
	}
	if _, ok := header["tsum"]; !ok {
		return "", "", nil, errors.New("not a Tsum list CSV: no tsum column")
	}
	japanese := false
	for _, rec := range records {
		t := cell(header, rec, "tsum")
		if t == "" {
			continue
		}
		name := cell(header, rec, "name")
		if b := cell(header, rec, "build"); b != "" && build == "" {
			build = b
		}
		if d := cell(header, rec, "device"); d != "" && device == "" {
			device = d
		}
		for _, c := range name {
			if c >= 0x3000 {
				japanese = true
				break
			}
		}
		rows = append(rows, OwnedTsum{
			Order:         intCell(cell(header, rec, "order")),
			Tsum:          t,
			Name:          name,
			Level:         intCell(cell(header, rec, "level")),
			LevelCap:      intCell(cell(header, rec, "level_cap")),
			Skill:         intCell(cell(header, rec, "skill")),
			SkillMax:      intCell(cell(header, rec, "skill_max")),
			SkillProgress: intCell(cell(header, rec, "skill_progress")),
			Acquired:      cell(header, rec, "acquired"),
		})
	}
	if build == "" {
		build = "global"
		if japanese {
			build = "jp"
		}
	}
	return build, device, rows, nil
}
