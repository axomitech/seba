from seba_ingest.chunking.chunker import PageInput, chunk_pages

PARA = "This sentence explains one idea clearly. " * 8


def pages(*texts, chapter=1, start=1):
    return [PageInput(start + i, t, chapter) for i, t in enumerate(texts)]


def test_chunks_respect_size_and_keep_page_ranges():
    chunks = chunk_pages(pages(*[PARA * 3 for _ in range(4)]), target=500, overlap=60)
    assert len(chunks) > 4
    assert all(len(c.content) <= 500 + 60 + 60 for c in chunks)
    assert chunks[0].page_start == 1 and chunks[-1].page_end == 4
    assert all(c.page_start <= c.page_end for c in chunks)
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


def test_chunks_never_cross_chapter_boundaries():
    ps = [PageInput(1, PARA, 1), PageInput(2, PARA, 1), PageInput(3, PARA, 2), PageInput(4, PARA, 2)]
    chunks = chunk_pages(ps, target=2000, overlap=100)
    assert {(c.chapter_ordinal, c.page_start, c.page_end) for c in chunks} == {(1, 1, 2), (2, 3, 4)}


def test_exercise_regions_are_labelled_and_separated():
    text = (f"2.1 Force and motion\n{PARA}\n\nEXERCISE 2.1\n\n1. What is force?\n\n2. State Newton's first law.\n\n"
            f"2.2 Momentum\n\n{PARA}")
    chunks = chunk_pages(pages(text), target=3000, overlap=0)
    kinds = [c.kind for c in chunks]
    assert kinds == ["body", "exercise", "body"]
    assert "What is force?" in chunks[1].content and "Newton" in chunks[1].content
    assert "Momentum" in chunks[2].content


def test_assamese_and_hindi_exercise_headings():
    for heading in ("অনুশীলনী", "प्रश्नावली"):
        chunks = chunk_pages(pages(f"{PARA}\n\n{heading}\n\n১. প্ৰশ্ন এক"), target=3000, overlap=0)
        assert [c.kind for c in chunks] == ["body", "exercise"], heading


def test_indic_danda_sentence_splitting_and_hard_split():
    long_indic = "এইটো এটা বাক্য। " * 120
    chunks = chunk_pages(pages(long_indic), target=300, overlap=0)
    assert len(chunks) > 3 and all(len(c.content) <= 300 for c in chunks)
    no_spaces = "x" * 1000
    assert all(len(c.content) <= 300 for c in chunk_pages(pages(no_spaces), target=300, overlap=0))


def test_overlap_repeats_tail_of_previous_chunk():
    chunks = chunk_pages(pages(PARA * 6), target=400, overlap=80)
    assert len(chunks) >= 3
    tail = chunks[0].content[-40:]
    assert tail.split()[-1] in chunks[1].content[:200]


def test_empty_and_whitespace_pages_produce_nothing():
    assert chunk_pages(pages("", "   \n\n  "), 500, 50) == []


def test_token_estimate_is_positive_for_all_scripts():
    chunks = chunk_pages(pages("সৰল অসমীয়া সাহিত্য " * 5, "plain english words " * 5), 100, 0)
    assert all(c.token_estimate > 0 for c in chunks)
