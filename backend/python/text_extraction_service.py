#!/usr/bin/env python3
"""
Text Extraction Service - Extracts text from PDF, EPUB, and MOBI files

Usage:
    python text_extraction_service.py <file_path> <file_type>

Args:
    file_path: Path to the document file
    file_type: File extension (.pdf, .epub, .mobi)

Output:
    JSON object with extracted text:
    {"text": "Extracted text content..."}

Requirements:
    pip install pdfplumber ebooklib beautifulsoup4
"""

import sys
import json
import os

def extract_pdf(file_path):
    """Extract text from PDF using pdfplumber"""
    try:
        import pdfplumber
    except ImportError:
        return {"error": "pdfplumber not installed. Run: pip install pdfplumber"}

    text_parts = []

    try:
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)

        return {"text": "\n\n".join(text_parts)}
    except Exception as e:
        return {"error": f"PDF extraction failed: {str(e)}"}


def extract_epub(file_path):
    """Extract text from EPUB using ebooklib"""
    try:
        import ebooklib
        from ebooklib import epub
        from bs4 import BeautifulSoup
    except ImportError:
        return {"error": "ebooklib or beautifulsoup4 not installed. Run: pip install ebooklib beautifulsoup4"}

    text_parts = []

    try:
        book = epub.read_epub(file_path)

        for item in book.get_items():
            if item.get_type() == ebooklib.ITEM_DOCUMENT:
                # Parse HTML content
                soup = BeautifulSoup(item.get_content(), 'html.parser')
                text = soup.get_text(separator='\n', strip=True)
                if text:
                    text_parts.append(text)

        return {"text": "\n\n".join(text_parts)}
    except Exception as e:
        return {"error": f"EPUB extraction failed: {str(e)}"}


def extract_mobi(file_path):
    """Extract text from MOBI

    Note: MOBI is more complex. For now, return an error suggesting conversion.
    In the future, we could use mobi or KindleUnpack library.
    """
    return {"error": "MOBI extraction not yet implemented. Please convert to EPUB or PDF first."}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: text_extraction_service.py <file_path> <file_type>"}))
        sys.exit(1)

    file_path = sys.argv[1]
    file_type = sys.argv[2].lower()

    # Check if file exists
    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        sys.exit(1)

    # Extract based on file type
    if file_type == '.pdf':
        result = extract_pdf(file_path)
    elif file_type == '.epub':
        result = extract_epub(file_path)
    elif file_type == '.mobi':
        result = extract_mobi(file_path)
    else:
        result = {"error": f"Unsupported file type: {file_type}"}

    # Output result as JSON
    print(json.dumps(result))

    # Exit with error code if extraction failed
    if "error" in result:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
