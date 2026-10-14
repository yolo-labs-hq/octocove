const ZERO = '0'.repeat(40);
/** HTTP discovery has a service preamble; ext:: expects only native ref packets.
 * Accept the Worker's empty capabilities marker and exact own ref, never a sibling. */
export function receiveAdvertisement(bytes, ref) {
  const fail = () => { throw new Error('helper: invalid claim advertisement'); };
  if(bytes.length>65536)fail();
  let offset=0, start=0, count=0, oldSha, empty=false, finished=false, firstEnd;
  while(offset<bytes.length){
    const header=bytes.subarray(offset,offset+4).toString();if(!/^[0-9a-f]{4}$/i.test(header))fail();
    const length=parseInt(header,16), beginning=offset;offset+=4;
    if(length===0){
      if(start===0 && count===-1){start=offset;count=0;continue;}
      if(count<1 || offset!==bytes.length)fail();finished=true;break;
    }
    if(length<5 || offset+length-4>bytes.length)fail();
    const line=bytes.subarray(offset,offset+length-4).toString();offset+=length-4;
    if(beginning===0 && line==='# service=git-receive-pack\n'){count=-1;continue;}
    if(count<0 || !line.endsWith('\n'))fail();
    const fields=line.slice(0,-1).split('\0');
    if(fields.length>2 || (count!==0 && fields.length!==1))fail();
    if(count===0 && (fields.length!==2 || !fields[1].split(' ').includes('report-status') || /object-format=(?!sha1(?: |$))/.test(fields[1])))fail();
    const match=/^([a-f0-9]{40}) (.+)$/.exec(fields[0]);if(!match)fail();
    const [_,oid,name]=match;
    if(name==='capabilities^{}'){if(count!==0 || oid!==ZERO)fail();empty=true;oldSha=ZERO;}
    else if(name===ref){if(count!==0 || oid===ZERO)fail();oldSha=oid;}
    else if(name==='.have'){if(count===0 || oid===ZERO)fail();}
    else fail();
    if(count===0)firstEnd=offset;
    count++;
  }
  if(!finished || oldSha===undefined || (empty && count<1))fail();
  // Git's native empty-ref parser expects flush immediately after capabilities^{}.
  // The Worker's .have hints are validated above, but omitted for this fresh
  // shape so Git emits a self-contained pack instead of a protocol error.
  return { bytes:empty ? Buffer.concat([bytes.subarray(start,firstEnd),Buffer.from('0000')]) : bytes.subarray(start), oldSha };
}
