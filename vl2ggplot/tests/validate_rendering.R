# Ad-hoc validation harness (not part of the testthat suite): unlike
# validate_examples.R (which runs in *strict* mode, i.e. ignore_unsupported =
# FALSE), this runs every example spec the way the showcase actually does --
# ignore_unsupported = TRUE -- and records the FULL error message for
# anything that still fails, not just the first line.
#
# The gap this closes: the showcase's own render_ggplot.R already reports an
# ok/fail count under ignore_unsupported, but only keeps the first line of
# each error -- "Problem while computing aesthetics." and "Problem while
# computing stat." are both ggplot2's *outer* wrapper message for a whole
# family of underlying causes (a missing column, an invalid stat input, a
# duplicate name, ...); the real cause is on the next line ("Caused by
# error: ..."), which this script preserves so failures can actually be
# triaged instead of only counted.
#
# Usage: Rscript tests/validate_rendering.R /path/to/specs/dir [/path/to/vega-datasets] [limit]

suppressPackageStartupMessages({
  library(vl2ggplot)
  library(ggplot2)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("Usage: Rscript tests/validate_rendering.R /path/to/specs/dir [/path/to/vega-datasets] [limit]")
specs_dir <- normalizePath(args[1])
datasets_dir <- if (length(args) >= 2 && !grepl("^[0-9]+$", args[2])) normalizePath(args[2]) else NA
limit_arg <- if (!is.na(datasets_dir)) args[3] else args[2]
limit <- if (!is.na(limit_arg) && length(limit_arg) && nzchar(limit_arg)) as.integer(limit_arg) else NA

detail_path <- file.path(getwd(), "tests", "validate-rendering-failures.txt")
old_wd <- getwd()
if (!is.na(datasets_dir)) setwd(datasets_dir)

files <- sort(list.files(specs_dir, pattern = "\\.vl\\.json$", full.names = FALSE))
if (!is.na(limit)) files <- head(files, limit)

ok <- 0
failed <- list()

for (file in files) {
  path <- file.path(specs_dir, file)
  spec <- tryCatch(jsonlite::fromJSON(path, simplifyVector = FALSE), error = function(e) NULL)
  if (is.null(spec)) next

  code <- tryCatch(vegalite_to_ggplot(spec, ignore_unsupported = TRUE), error = function(e) e)
  if (inherits(code, "error")) {
    failed[[length(failed) + 1]] <- list(file = file, stage = "TRANSLATE", message = conditionMessage(code), code = "")
    next
  }

  result <- tryCatch(
    {
      plot_obj <- suppressWarnings(suppressMessages(eval(parse(text = code), envir = new.env())))
      suppressWarnings(suppressMessages(ggplot2::ggplot_build(plot_obj)))
      NULL
    },
    error = function(e) e
  )
  if (!is.null(result)) {
    failed[[length(failed) + 1]] <- list(file = file, stage = "EXEC", message = conditionMessage(result), code = code)
    next
  }
  ok <- ok + 1
}

cat(sprintf("OK: %d/%d\n", ok, length(files)))
cat(sprintf("Failed (ignore_unsupported = TRUE): %d/%d\n", length(failed), length(files)))

# The first line of conditionMessage() is ggplot2's outer "Problem while
# ..." wrapper for a whole family of distinct underlying causes -- group by
# that first line to see how many failures share the same *symptom*
# (though not necessarily the same root cause), same as render_ggplot.R's
# own bucketing, but this script also keeps the full detail below.
top_reasons <- function(entries, n = 30) {
  if (length(entries) == 0) return(invisible())
  msgs <- vapply(entries, function(e) strsplit(e$message, "\n")[[1]][1], character(1))
  tbl <- sort(table(msgs), decreasing = TRUE)
  for (i in seq_len(min(n, length(tbl)))) {
    cat(sprintf("  [%3d] %s\n", tbl[i], names(tbl)[i]))
  }
}

cat("\nTop failure symptoms (first line only -- see detail file for the real cause):\n")
top_reasons(failed)

detail_lines <- if (length(failed) == 0) character(0) else unlist(lapply(failed, function(e) {
  c(sprintf("===== %s [%s] =====", e$file, e$stage), e$message, e$code, "")
}))
writeLines(detail_lines, detail_path)
cat(sprintf("\nFull details (every failure's complete error message) written to %s\n", detail_path))
setwd(old_wd)
