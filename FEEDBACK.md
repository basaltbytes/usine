## Code quality feedback

### @usine/core
- Entities seem hollow, are they just Struct ? Is there no domain logic attached to them at all ?
I don't mean to attach state to entity, I prefer purity of functions and effect paradigm but there
probably should be some presenter, deriver, attached to it no ? At least to make code look more
fluid.
- Comments are inconsistent, sometimes you repeat "Value object: xxxx" as the docbloc ? For what ?
- Also If our value objects are just Effect Schema with brand, maybe there is no need to name them
"Value object". I know I forced DDD/Hexagonal architecture at the start but these nomenclature look
forced now on very simple code that, in my opinion don't hold their own as value objects. I may be wrong
feel free to explain to me why.
- packages/core/src/repository.ts and packages/core/src/name.ts contains "value object" `Name`. This generic
"name" is terrible, and you always alias it with import and the brand is also WorkerName in the end. please
fix.
- overall we are almost always disappointed by scanning the filenames and opening the content, it's always
slightly uncanny. There is packages/core/src/attempt-channel.ts and also a folder `lifecycle` with attempt.
It may also be due to the fact that you file don't lead with the class of the same name, you declare lots
of struct/schema and then scrolling down we see the class. For humans this is harder to understand.
- Can you explain to me the double export ?
```
export const StepName = Schema.NonEmptyString.pipe(Schema.brand("StepName"));
export type StepName = typeof StepName.Type;
```
Is it because we don't have a bundler or something ? Or is there something I don't understand ? Is it
really necessary ? As a human it confuses me and it looks like more code to keep in sync, pretty sure
I can import StepName and directly inline `<typeof StepName.Type>`. This pattern is multiplied in almost
all the files of the package. If you don't have any good narrative for it, let's eliminate that everywhere.
BUt from what I saw they are never imported.
- Please no barrel export, declare your package.json correctly.
- A lot of so-called value-objects are not imported anywhere ? 

### @usine/engine

- Most comments (not all) you wrote are super shit, self explainatory but even worst they read like terrible 
AI slop, example:

```
/** A worker-capacity reservation held while one Attempt runs. */
export interface WorkerLease {
  readonly worker: Worker.Name;
  readonly release: Effect.Effect<void>;
}
```

Dude just write clearly: Represents the reservation of the caopacity of a Worker while an attempt is running.

Sometimes you talk about code parts like they "holds, carries," shit like that. But code is made to be used
and called, it should be explain in the context of a user calling the piece of code, why and how. Come on.

Also these kind of comments, that references gh issues to describe a Class ? wtf just say what it does
and if at the time of creating that then you didn't have the full picture because it was supposed to be
implemented in other issue... Then that's the perfect example of WHY comments are another code to maintain !
If you decide to fucking write them you have to fucking maintain them. Or simply don't and make code self explanatory.
```
/**
 * Port for one Attempt. #29 supplies the worker-backed adapter; #26 exercises
 * the durable engine against implementations of this interface.
 */
 ```


 ### We need good Effect example of file structure, pre-AI
 - sometimes we do hese "model.ts" files that are full of Schema ? Where does that come from
 I actually don't hate it in concept but I hate that's it's called singular form "model" instead
 of "models" though. 

 ### Can we make the tasks engine agnostic ? 
 Right now it's GitHub, but could it be local files ? Each task a markdown file ? Could it be Jira ? Or 
 Linear ?

 I am really not sure about the state of the engine workflow be linked to the github label, looks like
 coupling and it's strange when we have our own persistance layer. Our abstraction of a task containing its 
 description, origin, associated PR, etc should be own by us no ? Would love usine, in it's simplest form to
 be able to run fully locally.
 

 ### Knip config strange

 Why `"ignoreExportsUsedInFile": true` ?
 Some files/paths should be ignored but are not like the route tree gen of tanstack