# Ad-hoc validation harness (not part of the testthat suite): run the
# translator over a directory of real-world *.vl.json example specs,
# execute the generated code, and report OK/Skipped/Failed counts grouped
# by reason -- mirroring vl2d3's three-bucket approach, since vl2ggplot
# (like vl2d3) can legitimately encounter specs using features outside its
# scope, and that's not the same thing as a bug.
#
# Usage: Rscript tests/validate_examples.R /path/to/specs/dir [limit]

suppressPackageStartupMessages({
  library(vl2ggplot)
  library(ggplot2)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("Usage: Rscript tests/validate_examples.R /path/to/specs/dir [/path/to/vega-datasets] [limit]")
specs_dir <- normalizePath(args[1])
datasets_dir <- if (length(args) >= 2 && !grepl("^[0-9]+$", args[2])) normalizePath(args[2]) else NA
limit_arg <- if (!is.na(datasets_dir)) args[3] else args[2]
limit <- if (!is.na(limit_arg) && length(limit_arg) && nzchar(limit_arg)) as.integer(limit_arg) else NA

# `url`-sourced example specs reference data with a path relative to a
# vega-datasets checkout's own root (e.g. "data/cars.json"); R's
# read.csv()/jsonlite::fromJSON() resolve a relative path against the
# current working directory, so running with that checkout as the working
# directory makes such paths resolve to real local files -- no need for an
# HTTP server the way vl2d3's harness needs one for a browser-realm fetch().
detail_path <- file.path(getwd(), "tests", "validate_failures.txt")
old_wd <- getwd()
if (!is.na(datasets_dir)) setwd(datasets_dir)

files <- sort(list.files(specs_dir, pattern = "\\.vl\\.json$", full.names = FALSE))
if (!is.na(limit)) files <- head(files, limit)

ok <- 0
skipped <- list()
failed <- list()

for (file in files) {
  path <- file.path(specs_dir, file)
  spec <- tryCatch(jsonlite::fromJSON(path, simplifyVector = FALSE), error = function(e) NULL)
  if (is.null(spec)) next

  code <- tryCatch(vegalite_to_ggplot(spec), error = function(e) e)
  if (inherits(code, "error")) {
    entry <- list(file = file, stage = "TRANSLATE", message = conditionMessage(code), code = "")
    if (startsWith(conditionMessage(code), "Unsupported")) {
      skipped[[length(skipped) + 1]] <- entry
    } else {
      failed[[length(failed) + 1]] <- entry
    }
    next
  }

  result <- tryCatch(
    {
      plot_obj <- eval(parse(text = code), envir = new.env())
      ggplot2::ggplot_build(plot_obj)
      NULL
    },
    error = function(e) e
  )
  if (!is.null(result)) {
    entry <- list(file = file, stage = "EXEC", message = conditionMessage(result), code = code)
    if (startsWith(conditionMessage(result), "Unsupported")) {
      skipped[[length(skipped) + 1]] <- entry
    } else {
      failed[[length(failed) + 1]] <- entry
    }
    next
  }
  ok <- ok + 1
}

cat(sprintf("OK: %d/%d\n", ok, length(files)))
cat(sprintf("Skipped (documented unsupported features): %d/%d\n", length(skipped), length(files)))
cat(sprintf("Failed (unexpected): %d/%d\n", length(failed), length(files)))

top_reasons <- function(entries, n = 20) {
  if (length(entries) == 0) return(invisible())
  msgs <- vapply(entries, function(e) e$message, character(1))
  tbl <- sort(table(msgs), decreasing = TRUE)
  for (i in seq_len(min(n, length(tbl)))) {
    cat(sprintf("  [%3d] %s\n", tbl[i], names(tbl)[i]))
  }
}

cat("\nTop skip reasons:\n")
top_reasons(skipped)

cat("\nTop failure reasons (unexpected -- these are real bugs):\n")
top_reasons(failed)

detail_lines <- if (length(failed) == 0) character(0) else unlist(lapply(failed, function(e) {
  c(sprintf("===== %s [%s] =====", e$file, e$stage), e$message, e$code, "")
}))
writeLines(detail_lines, detail_path)
cat(sprintf("\nFull details written to %s\n", detail_path))
setwd(old_wd)
