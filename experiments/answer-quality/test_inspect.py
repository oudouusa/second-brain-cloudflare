"""固定fixture用の警告検出。意味評価を自動合格に置き換えない。"""
import json
from pathlib import Path
import unittest
from run import inspect_answer

CASE = json.loads(Path(__file__).with_name("cases.json").read_text())[1]


class InspectTest(unittest.TestCase):
    def test_relevant_citation_alone_is_sufficient(self):
        checks = inspect_answer("公開日は未定で、承認待ちです。[2]", CASE)
        self.assertTrue(checks["required_citations_present"])
        self.assertTrue(checks["japanese_present"])
        self.assertEqual(checks["unexpected_letters"], [])
        self.assertEqual(checks["unsupported_years"], [])

    def test_observed_unsupported_year_and_language(self):
        checks = inspect_answer("2025年時点では未定です。[2] ઉત્પાદન", CASE)
        self.assertEqual(checks["unsupported_years"], ["2025"])
        self.assertTrue(checks["unexpected_letters"])

    def test_wrong_citation_and_english_only(self):
        checks = inspect_answer("The launch date is unknown. [3]", CASE)
        self.assertFalse(checks["japanese_present"])
        self.assertFalse(checks["citations_in_range"])
        self.assertFalse(checks["required_citations_present"])


class StreamTest(unittest.TestCase):
    def event(self, content=None, reason=None):
        return 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': {} if content is None else {'content': content}, 'finish_reason': reason}]}) + '\n\n'

    def parse(self, raw):
        from run import parse_answer_stream
        return parse_answer_stream(raw)

    def test_complete(self):
        for newline in ['\n', '\r\n']:
            raw = self.event('未定です。[2]') + self.event(reason='stop') + 'data: [DONE]\n\n'
            self.assertEqual(self.parse(raw.replace('\n', newline))['text'], '未定です。[2]')

    def test_content_is_not_terminal_event(self):
        with self.assertRaises(ValueError):
            self.parse(self.event('本文内の data: [DONE] です。[2]'))

    def test_truncation_and_non_stop(self):
        for reason in [None, 'length', 'content_filter']:
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                self.parse(self.event('未定です。[2]', reason) + 'data: [DONE]\n\n')

    def test_after_done_and_broken_json(self):
        good = self.event('未定です。[2]', 'stop') + 'data: [DONE]\n\n'
        for raw in [good + self.event('余分'), 'data: {broken}\n\n', 'data: {"error":"failure"}\n\n', good.rstrip()]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.parse(raw)

    def test_endpoint_and_redirect(self):
        from run import valid_endpoint, NoRedirect
        self.assertTrue(valid_endpoint('https://example.test'))
        for url in ['http://example.test', 'https://user:password@example.test', 'https://example.test?token=x', 'https://example.test#fragment', 'https://example.test?', 'https://example.test#', 'https://example.test:bad', 'https://']:
            self.assertFalse(valid_endpoint(url))
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.test'))

    def test_question_does_not_authorize_year(self):
        case = {**CASE, 'query': '2025年ですか？'}
        self.assertEqual(inspect_answer('２０２５年です。[2]', case)['unsupported_years'], ['2025'])


if __name__ == "__main__":
    unittest.main()
