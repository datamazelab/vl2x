#!/usr/bin/env Rscript
# Batch-run vl2ggplot over every spec in vega-lite-example-specs/: write the
# generated code, evaluate it, and ggsave() a PNG render per example that
# succeeds. Writes a status JSON summarizing ok/error per example.

suppressMessages({
  library(vl2ggplot)
  library(ggplot2)
  library(jsonlite)
})

repo <- normalizePath(getwd()) # must be invoked from the repo root
specs_dir <- file.path(repo, "vega-lite-example-specs")
out_dir <- file.path(repo, "showcase", "examples")
renders_dir <- file.path(repo, "showcase", "renders")
dir.create(renders_dir, showWarnings = FALSE, recursive = TRUE)

files <- sort(list.files(specs_dir, pattern = "\\.vl\\.json$", full.names = FALSE))
statuses <- list()

# Generated code uses relative "data/..." paths -- resolve them against
# showcase/data (a copy of vega-datasets) by running from showcase/.
old_wd <- setwd(file.path(repo, "showcase"))

for (i in seq_along(files)) {
  fname <- files[i]
  name <- sub("\\.vl\\.json$", "", fname)
  example_dir <- file.path(out_dir, name)
  dir.create(example_dir, showWarnings = FALSE, recursive = TRUE)
  png_path <- file.path(renders_dir, paste0(name, ".png"))

  result <- tryCatch({
    spec <- jsonlite::fromJSON(file.path(specs_dir, fname), simplifyVector = FALSE)
    code <- vegalite_to_ggplot(spec, ignore_unsupported = TRUE)
    writeLines(code, file.path(example_dir, "ggplot.R"))

    env <- new.env()
    plot_obj <- suppressWarnings(suppressMessages(
      eval(parse(text = code), envir = env)
    ))
    ggplot2::ggsave(png_path, plot = plot_obj, width = 7, height = 5, dpi = 120, bg = "white")
    list(ok = TRUE)
  }, error = function(e) {
    msg <- strsplit(conditionMessage(e), "\n")[[1]][1]
    code_path <- file.path(example_dir, "ggplot.R")
    if (!file.exists(code_path)) writeLines(sprintf("# Translation failed:\n# %s", msg), code_path)
    if (file.exists(png_path)) unlink(png_path)
    list(ok = FALSE, error = msg)
  })

  statuses[[name]] <- result
  if (i %% 50 == 0) cat(sprintf("ggplot: %d/%d\n", i, length(files)), file = stderr())
}

setwd(old_wd)

jsonlite::write_json(statuses, file.path(repo, "showcase", "status_ggplot.json"), auto_unbox = TRUE)
ok_count <- sum(vapply(statuses, function(s) isTRUE(s$ok), logical(1)))
cat(sprintf("ggplot: %d/%d ok\n", ok_count, length(files)))
