#!/usr/bin/env python3
"""Export compact native Docling output for libgen-downloader."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import ImageRefMode


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--markdown", action="store_true")
    return parser.parse_args()


def clear_outputs(output: Path) -> None:
    for target in (
        output / "source.json",
        output / "source.md",
        output / "source_artifacts",
    ):
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()


def convert(source: Path, output: Path, include_markdown: bool, enrich: bool) -> None:
    source = source.resolve()
    output = output.resolve()
    pdf_options = PdfPipelineOptions()
    pdf_options.do_formula_enrichment = enrich
    pdf_options.generate_page_images = False
    pdf_options.generate_picture_images = True
    pdf_options.images_scale = 2

    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options),
        }
    )
    result = converter.convert(source)
    output.mkdir(parents=True, exist_ok=True)
    previous_directory = Path.cwd()
    try:
        os.chdir(output)
        result.document.save_as_json(
            Path("source.json"),
            image_mode=ImageRefMode.REFERENCED,
        )
        if include_markdown:
            result.document.save_as_markdown(
                Path("source.md"),
                image_mode=ImageRefMode.REFERENCED,
            )
    finally:
        os.chdir(previous_directory)


def main() -> None:
    arguments = parse_arguments()
    try:
        convert(arguments.source, arguments.output, arguments.markdown, enrich=True)
    except Exception as enriched_error:
        print(
            f"Formula enrichment failed; retrying without it: {enriched_error}",
            file=sys.stderr,
        )
        clear_outputs(arguments.output)
        convert(arguments.source, arguments.output, arguments.markdown, enrich=False)


if __name__ == "__main__":
    main()
