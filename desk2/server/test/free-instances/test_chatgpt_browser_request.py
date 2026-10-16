"""No-network guards for first-party request handoff, privacy and single dispatch."""
import asyncio
from copy import deepcopy
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from claudfree.chatgpt.browser_request import _prepare, browser_slot, markers_missing, request_headers, validate
from claudfree.chatgpt.quiet_window import SPOT, FocusReturn
from claudfree.chatgpt.http import ChatGPTHttp, TEXT_MODEL
from claudfree.errors import ClaudeError


def payload():
    return {'action':'next','messages':[{'id':str(uuid4()),'author':{'role':'user'},
        'content':{'content_type':'text','parts':['Example prompt']}}],
        'parent_message_id':str(uuid4()),'model':TEXT_MODEL,'history_and_training_disabled':True}


class BrowserRequestTests(unittest.TestCase):
    def test_authorization_is_required_before_dispatch(self):
        for authorization in [None, '', 'Bearer ', 'Bearer fixture\r\nOther: invalid', 'Basic fixture']:
            with self.subTest(authorization=authorization), self.assertRaises(ClaudeError):
                request_headers({'Authorization':authorization})
        with self.assertRaises(ClaudeError):request_headers({})

    def test_real_authorization_is_retained_without_connection_owned_headers(self):
        headers=request_headers({'authorization':'Bearer fixture-only','Cookie':'private',
            'Host':'chatgpt.com','Content-Length':'1','oai-did':'fixture-device'})
        self.assertEqual(headers,{'authorization':'Bearer fixture-only','oai-did':'fixture-device'})

    def test_three_browser_slots_queue_without_launching_a_fourth_and_release(self):
        with tempfile.TemporaryDirectory() as root, patch.dict('os.environ',{'CLAUDFREE_CACHE_DIR':root}):
            with ExitStack() as held:
                for _ in range(3):held.enter_context(browser_slot(Path(root),wait=0))
                with self.assertRaises(ClaudeError) as error:
                    with browser_slot(Path(root),wait=0):self.fail('A fourth slot was granted')
                self.assertEqual(error.exception.code,'browser_busy')
            with browser_slot(Path(root),wait=0):pass
    def test_missing_empty_expired_or_wrong_domain_markers_need_browser_completion(self):
        def jar(exp=200):
            return [{'name':n,'value':'fixture','domain':'.chatgpt.com','expires':exp} for n in ('_uasid','_umsid')]
        self.assertFalse(markers_missing(jar(),now=100))
        self.assertFalse(markers_missing(jar(-1),now=100))
        for cookies in [[],jar()[:1],jar(100),[{**c,'value':''} for c in jar()],
                        [{**c,'domain':'auth.openai.com'} for c in jar()]]:
            self.assertTrue(markers_missing(cookies,now=100))
    def test_exact_new_and_continued_temporary_requests_are_accepted(self):
        p=payload()
        validate(p,'Example prompt',None)
        existing={'conversation_id':str(uuid4()),'current_node':p['parent_message_id']}
        validate({**p,'conversation_id':existing['conversation_id']},'Example prompt',existing)

    def test_other_text_actions_threads_branches_and_privacy_modes_are_refused(self):
        existing={'conversation_id':str(uuid4()),'current_node':str(uuid4())}
        bad=[{**payload(),'action':'variant'},{**payload(),'messages':[]},
             {**payload(),'history_and_training_disabled':False},
             {**payload(),'temporary_chat_requests_personalization':True},
             {**payload(),'conversation_id':str(uuid4())}]
        other=payload();other['messages'][0]['content']['parts']=['Other text'];bad.append(other)
        malformed=payload();malformed['messages'][0]['author']=None;bad.append(malformed)
        for p in bad:
            with self.subTest(payload=p),self.assertRaises(ClaudeError):validate(p,'Example prompt',None)
        for p in [payload(),{**payload(),'conversation_id':existing['conversation_id']}]:
            with self.assertRaises(ClaudeError):validate(p,'Example prompt',existing)

    def test_prepared_request_sends_once_and_never_consumes_another_preparation(self):
        h=ChatGPTHttp({'cookies':[]},preparations=Mock())
        conversation=str(uuid4());node=str(uuid4())
        body={'conversation_id':conversation,'current_node':node,'is_temporary_chat':True,
              'mapping':{node:{'parent':None,'message':{'id':node,'author':{'role':'assistant'},
                  'content':{'content_type':'text','parts':['Example reply']},'status':'finished_successfully'}}}}
        h._request=Mock();h.read=Mock(return_value=body)
        request={'payload':payload(),'headers':{'Authorization':'Bearer fixture-only'}}
        try:
            with patch('claudfree.chatgpt.http._read_stream',return_value=(conversation,True)):
                result=h.send('Example prompt',prepared_request=request)
            self.assertEqual(result[2]['text'],'Example reply')
            self.assertEqual(h._request.call_count,1)
            h.preparations.take.assert_not_called()
            self.assertEqual(h._request.call_args.kwargs['headers']['Authorization'],'Bearer fixture-only')
            invalid=deepcopy(request);invalid['payload']['model']='gpt-other'
            with self.assertRaises(ClaudeError):h.send('Example prompt',prepared_request=invalid)
            self.assertEqual(h._request.call_count,1)
        finally:h.close()

    def test_browser_completed_message_is_read_without_a_second_post(self):
        h=ChatGPTHttp({'cookies':[]},preparations=Mock())
        conversation=str(uuid4());node=str(uuid4())
        h._request=Mock(side_effect=AssertionError('A completed message must not be posted again'))
        h.read=Mock(return_value={'conversation_id':conversation,'current_node':node,'is_temporary_chat':True,
            'mapping':{node:{'parent':None,'message':{'id':node,'author':{'role':'assistant'},
                'content':{'content_type':'text','parts':['Example reply']},'status':'finished_successfully'}}}})
        on_id=Mock()
        try:
            result=h.send('Example prompt',on_id=on_id,prepared_request={
                'payload':payload(),'headers':{},'already_sent':True,'server_id':conversation})
            self.assertEqual(result[2]['text'],'Example reply')
            h._request.assert_not_called()
            h.preparations.take.assert_not_called()
            on_id.assert_called_once_with(conversation)
        finally:h.close()


class FakeWindows:
    """The foreground window and where each window sits."""
    def __init__(self, now, spots):self.now,self.spots,self.handed=now,spots,[]
    def foreground(self):return self.now
    def position(self,window):return self.spots[window]
    def exists(self,window):return window in self.spots
    def activate(self,window,holder):self.handed.append((window,holder));self.now=window


class QuietWindowTests(unittest.TestCase):
    def test_the_request_browser_opens_beyond_the_screen(self):
        start=AsyncMock(side_effect=RuntimeError('stop after launch'))
        http=Mock(timeout=120);http.saved_state.return_value={'cookies':[]}
        with tempfile.TemporaryDirectory() as root, patch('zendriver.start',start), self.assertRaises(RuntimeError):
            asyncio.run(_prepare(http,'Example prompt',None,directory=root,model=TEXT_MODEL,temporary=True,on_id=None))
        position=[a for a in start.call_args.kwargs['browser_args'] if a.startswith('--window-position=')]
        self.assertEqual(len(position),1)
        self.assertTrue(all(int(v)<-10000 for v in position[0].split('=')[1].split(',')))

    def test_the_browser_taking_the_keyboard_gives_it_straight_back(self):
        windows=FakeWindows('desk',{'desk':(0,0),'chrome':SPOT})
        focus=FocusReturn(windows)
        windows.now='chrome';focus.step()
        self.assertEqual(windows.handed,[('desk','chrome')])
        self.assertEqual(windows.now,'desk')

    def test_the_person_switching_apps_is_left_alone_and_followed(self):
        windows=FakeWindows('desk',{'desk':(0,0),'editor':(-1920,0),'chrome':SPOT})
        focus=FocusReturn(windows)
        windows.now='editor';focus.step()
        self.assertEqual(windows.handed,[])
        windows.now='chrome';focus.step()
        self.assertEqual(windows.handed,[('editor','chrome')])

    def test_another_requests_browser_is_never_the_window_returned_to(self):
        windows=FakeWindows('other request',{'desk':(0,0),'other request':SPOT,'chrome':SPOT})
        focus=FocusReturn(windows)
        windows.now='chrome';focus.step()
        self.assertEqual(windows.handed,[])
        windows.now='desk';focus.step();windows.now='chrome';focus.step()
        self.assertEqual(windows.handed,[('desk','chrome')])


if __name__=='__main__':unittest.main()
